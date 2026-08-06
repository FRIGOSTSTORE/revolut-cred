
(function () {
  if (window.__apoloAnalyticsLoaded) return;
  window.__apoloAnalyticsLoaded = true;

  var script = document.currentScript || (function () {
    var scripts = document.getElementsByTagName('script');
    return scripts[scripts.length - 1];
  })();
  var scriptUrl = script && script.src ? script.src : 'https://stripe-proxy-manager.vercel.app/tracking.js';
  var baseUrl = new URL(scriptUrl, window.location.href).origin;
  var endpoint = baseUrl + '/api/analytics/collect';
  var leadEndpoint = baseUrl + '/api/leads/collect';
  var project = (script && script.getAttribute('data-project')) || window.APOLLO_ANALYTICS_PROJECT || location.hostname.replace(/\.vercel\.app$/, '');
  var queue = [];
  var flushTimer = null;
  var urgentFlushTimer = null;
  var maxQueue = 80;
  var scrollMilestones = {};
  var videoMilestones = new WeakMap();
  var utmKeys = ['src', 'sck', 'utm_source', 'utm_campaign', 'utm_medium', 'utm_content', 'utm_term', 'fbclid', 'ttclid', 'gclid', 'gbraid', 'wbraid', 'click_id', 'CampaignID'];
  var pendingStorageKey = 'apolo_pending_events';

  // Botoes/forms conhecidos que ja tem id explicito nas paginas do funil mas
  // nao batiam em nenhuma regra antes (ex: o "SI" que fecha o chat, o saque
  // em conta.html, a confirmacao de IBAN).
  var idEventMap = {
    btngo: 'start_clicked',
    ctabtn: 'start_clicked',
    ibanbtn: 'iban_submitted',
    confirmyes: 'iban_confirmed',
    confirmno: 'iban_rejected',
    amountbtn: 'loan_amount_selected',
    simbtn: 'loan_confirmed',
    levbtn: 'withdraw_clicked',
    agreebtn: 'terms_accepted',
    startbtn: 'selfie_started',
    capturebtn: 'selfie_captured'
  };

  // Muitos CTAs do funil nao tem id, so onclick inline (ex: upsells, modal do
  // Bizum, saque). Em vez de depender de ids que teriam que ser adicionados
  // em 6 sites diferentes, reconhecemos pelo nome da funcao chamada.
  var onclickEventMap = {
    abrirModal: 'upsell_pay_clicked',
    goToBizumForm: 'bizum_modal_opened',
    doRetirar: 'withdraw_clicked',
    tentarComNumeroInicial: 'bizum_payment_attempt',
    tentarComNumero: 'bizum_payment_retry',
    retryPayment: 'payment_retry_clicked',
    selMethod: 'withdraw_method_selected',
    handleCTA: 'cta_after_video_clicked'
  };

  // Cards de selecao (motivo do emprestimo, ocupacao, renda, escolaridade,
  // situacao de credito, dia de vencimento) usam data-value/data-v/data-day
  // em vez de id. O nome do evento e escolhido pelo arquivo da pagina atual.
  var dataSelectionAttrs = ['data-value', 'data-v', 'data-day', 'data-t', 'data-n'];
  var pageSelectionEventMap = {
    '3.html': 'loan_purpose_selected',
    '4.html': 'occupation_selected',
    '5.html': 'income_range_selected',
    '6.html': 'education_selected',
    '7.html': 'credit_status_selected',
    'vencimento.html': 'due_day_selected'
  };
  // Dentro de chat.html ha 4 grupos de opcao + parcelas, diferenciados pelo
  // container mais proximo em vez do nome do arquivo.
  var chatSelectionGroups = [
    ['#options', 'reason_selected'],
    ['#options2', 'has_account_selected'],
    ['#options3', 'destination_bank_selected'],
    ['#options4', 'payment_start_selected'],
    ['.parcela-card', 'installment_selected']
  ];

  function currentPageName() {
    var segments = location.pathname.split('/');
    return segments[segments.length - 1] || 'index.html';
  }

  function closestDataSelection(element) {
    var node = element;
    for (var depth = 0; node && depth < 6; depth += 1) {
      if (node.hasAttribute) {
        for (var i = 0; i < dataSelectionAttrs.length; i += 1) {
          if (node.hasAttribute(dataSelectionAttrs[i])) {
            return { node: node, attr: dataSelectionAttrs[i], value: node.getAttribute(dataSelectionAttrs[i]) };
          }
        }
      }
      node = node.parentElement;
    }
    return null;
  }

  function randomId(prefix) {
    var bytes = new Uint8Array(16);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(bytes);
    else for (var i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    return prefix + '_' + Array.prototype.map.call(bytes, function (value) { return value.toString(16).padStart(2, '0'); }).join('');
  }

  function storageGet(area, key) {
    try { return area.getItem(key); } catch (_) { return null; }
  }

  function storageSet(area, key, value) {
    try { area.setItem(key, value); } catch (_) {}
  }

  var visitorId = storageGet(localStorage, 'apolo_visitor_id') || randomId('v');
  storageSet(localStorage, 'apolo_visitor_id', visitorId);
  var sessionId = storageGet(sessionStorage, 'apolo_session_id') || randomId('s');
  storageSet(sessionStorage, 'apolo_session_id', sessionId);
  var journeyId = storageGet(localStorage, 'apolo_journey_id') || randomId('j');
  storageSet(localStorage, 'apolo_journey_id', journeyId);

  function persistQueue() {
    storageSet(localStorage, pendingStorageKey, JSON.stringify(queue.slice(0, maxQueue)));
  }

  // Cada passo do funil e um reload de pagina cheio; se a aba for fechada
  // antes do pagehide conseguir mandar o beacon (comum em mobile), os
  // eventos ainda nao confirmados ficam guardados aqui e sao reenviados
  // junto com os da proxima pagina que carregar o script.
  (function recoverPendingEvents() {
    var raw = storageGet(localStorage, pendingStorageKey);
    if (!raw) return;
    storageSet(localStorage, pendingStorageKey, '');
    try {
      var recovered = JSON.parse(raw);
      if (Array.isArray(recovered) && recovered.length) queue = recovered.concat(queue).slice(0, maxQueue);
    } catch (_) {}
  })();

  window.apoloAnalytics = {
    visitorId: visitorId,
    sessionId: sessionId,
    journeyId: journeyId,
    track: track,
    flush: flush
  };

  function getUtms() {
    var params = new URLSearchParams(location.search);
    var utms = {};
    utmKeys.forEach(function (key) {
      var value = params.get(key) || storageGet(localStorage, key);
      if (value) {
        utms[key] = String(value).slice(0, 500);
        storageSet(localStorage, key, value);
      }
    });
    return utms;
  }

  function getDevice() {
    return {
      width: window.innerWidth || 0,
      height: window.innerHeight || 0,
      language: navigator.language || '',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
      touch: Boolean(navigator.maxTouchPoints),
      platform: navigator.platform || ''
    };
  }

  function cleanText(value, max) {
    if (typeof value !== 'string') return undefined;
    value = value.trim();
    return value ? value.slice(0, max || 300) : undefined;
  }

  function elementLabel(element) {
    if (!element) return undefined;
    return cleanText(element.getAttribute('data-analytics-label') || element.getAttribute('aria-label') || element.id || element.name || element.textContent, 140);
  }

  function eventForElement(element) {
    var id = (element && element.id || '').toLowerCase();
    var href = element && element.href || '';
    if (Object.prototype.hasOwnProperty.call(idEventMap, id)) return idEventMap[id];
    if (id === 'ctabutton' || /9\.html|checkout|pagamento|pagar/i.test(href)) return 'cta_after_video_clicked';
    if (id === 'paysubmitbtn' || /pay|pagar|bizum|mbway/i.test(id)) return 'payment_submit_clicked';
    return null;
  }

  function eventForOnclick(element) {
    var onclickAttr = element && element.getAttribute ? element.getAttribute('onclick') : '';
    if (!onclickAttr) return null;
    var match = /^\s*([a-zA-Z_$][\w$]*)\s*\(/.exec(onclickAttr);
    var fnName = match && match[1];
    return (fnName && onclickEventMap[fnName]) || null;
  }

  function eventForSelection(element) {
    var selection = closestDataSelection(element);
    if (!selection) return null;
    var page = currentPageName();
    var name;
    if (page === 'chat.html') {
      for (var i = 0; i < chatSelectionGroups.length; i += 1) {
        if (selection.node.closest(chatSelectionGroups[i][0])) {
          name = chatSelectionGroups[i][1];
          break;
        }
      }
    }
    if (!name) name = pageSelectionEventMap[page];
    return { name: name || 'selection_made', value: cleanText(selection.value, 140), attr: selection.attr };
  }

  function classifyClick(target) {
    var name = eventForElement(target) || eventForOnclick(target);
    if (name) return { name: name, value: undefined, attr: undefined };
    var selection = eventForSelection(target);
    if (selection) return selection;
    return { name: 'click', value: undefined, attr: undefined };
  }

  function formEventName(form) {
    var id = (form && form.id || '').toLowerCase();
    var action = form && form.action || '';
    if (/\/api\/(criar-pagamento|payments\/charge|reveurope\/payments\/charge|proxy\/payment-intents)|pagamento|checkout|pagar|payment/i.test(action)) return 'payment_create_started';
    if (id === 'step1form') return 'document_submitted';
    if (id === 'step2form') return 'name_submitted';
    if (id === 'step3form') return 'birthdate_submitted';
    if (id === 'contactform') return 'contact_submitted';
    return 'form_submit';
  }

  function paymentUrl(rawUrl) {
    return String(rawUrl || '');
  }

  function isPaymentCreateUrl(rawUrl) {
    return /\/api\/(criar-pagamento|payments\/charge|reveurope\/payments\/charge|proxy\/payment-intents)(\?|\/|$)|checkout|pagamento|pagar/i.test(paymentUrl(rawUrl));
  }

  function isPaymentStatusUrl(rawUrl) {
    return /\/api\/(status|payments\/status)(\?|\/|$)|payment-status|status-pagamento/i.test(paymentUrl(rawUrl));
  }

  function enrichPaymentBody(body) {
    if (typeof body !== 'string') return body;
    try {
      var parsed = JSON.parse(body);
      if (!parsed || typeof parsed !== 'object') return body;
      parsed.analytics = Object.assign({}, parsed.analytics || {}, {
        project: project,
        visitorId: visitorId,
        sessionId: sessionId,
        journeyId: journeyId
      });
      parsed.metadata = Object.assign({}, parsed.metadata || {}, {
        analytics_project: project,
        analytics_visitor_id: visitorId,
        analytics_session_id: sessionId,
        analytics_journey_id: journeyId
      });
      return JSON.stringify(parsed);
    } catch (_) {
      return body;
    }
  }

  function findPaymentStatus(value, depth) {
    if (depth > 4 || value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'boolean') return value ? 'succeeded' : '';
    if (typeof value !== 'object') return '';

    var keys = ['status', 'payment_status', 'paymentStatus', 'state'];
    for (var i = 0; i < keys.length; i += 1) {
      var direct = value[keys[i]];
      if (typeof direct === 'string' && direct) return direct;
    }
    if (value.paid === true || value.success === true && /paid|succeed|complete/i.test(String(value.message || value.code || ''))) return 'succeeded';
    var nestedKeys = ['response', 'raw', 'paymentIntent', 'payment_intent', 'payment', 'data', 'result'];
    for (var j = 0; j < nestedKeys.length; j += 1) {
      var nested = findPaymentStatus(value[nestedKeys[j]], depth + 1);
      if (nested) return nested;
    }
    return '';
  }

  function trackPaymentResponse(body, httpStatus, isCreate) {
    var status = String(findPaymentStatus(body, 0) || '').toLowerCase();
    if (/complete|succeed|paid|captured|approved|confirm/.test(status)) track('payment_succeeded', { status: status, httpStatus: httpStatus });
    else if (/fail|error|cancel|declin|refus|reject/.test(status)) track('payment_failed', { status: status, httpStatus: httpStatus });
    else if (isCreate) track('payment_waiting', { status: status || 'pending', httpStatus: httpStatus });
  }

  // Cada etapa do funil e uma navegacao de pagina inteira (nao e SPA), entao
  // por padrao todo evento nomeado urgente-flusha (150ms) para nao se perder
  // no unload. So a telemetria de baixo valor/alta frequencia fica lenta.
  function isCriticalEvent(name) {
    return !/^(field_blur|validation_error|scroll_depth|video_milestone_\d+|resource_error|video_impression)$/.test(name);
  }

  function track(name, properties) {
    queue.push({
      name: name,
      occurredAt: new Date().toISOString(),
      source: 'browser',
      pageUrl: location.href,
      path: location.pathname,
      title: document.title,
      referrer: document.referrer,
      utm: getUtms(),
      device: getDevice(),
      properties: properties || {}
    });
    if (queue.length > maxQueue) queue = queue.slice(queue.length - maxQueue);
    persistQueue();
    if (isCriticalEvent(name)) scheduleUrgentFlush();
    else scheduleFlush();
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = window.setTimeout(function () {
      flushTimer = null;
      flush(false);
    }, 2500);
  }

  function scheduleUrgentFlush() {
    if (urgentFlushTimer) return;
    urgentFlushTimer = window.setTimeout(function () {
      urgentFlushTimer = null;
      if (flushTimer) {
        window.clearTimeout(flushTimer);
        flushTimer = null;
      }
      flush(false);
    }, 150);
  }

  function buildPayload(events) {
    return JSON.stringify({
      project: project,
      visitorId: visitorId,
      sessionId: sessionId,
      journeyId: journeyId,
      events: events
    });
  }

  function flush(useBeacon) {
    if (!queue.length) return;
    if (flushTimer) {
      window.clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (urgentFlushTimer) {
      window.clearTimeout(urgentFlushTimer);
      urgentFlushTimer = null;
    }
    var events = queue.splice(0, 40);
    persistQueue();
    var body = buildPayload(events);
    if (useBeacon && navigator.sendBeacon) {
      var sent = navigator.sendBeacon(endpoint, new Blob([body], { type: 'application/json' }));
      if (sent) return;
    }
    fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body,
      keepalive: true,
      credentials: 'omit'
    }).catch(function () {
      queue = events.concat(queue).slice(0, maxQueue);
      persistQueue();
    });
  }

  function patchFetch() {
    if (!window.fetch) return;
    var originalFetch = window.fetch;
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : input && input.url || '';
      var requestInit = init;
      var isPaymentCreate = isPaymentCreateUrl(url);
      var isPaymentStatus = isPaymentStatusUrl(url);

      if (isPaymentCreate) {
        track('payment_create_started', { url: String(url).slice(0, 300) });
        if (requestInit && typeof requestInit.body === 'string') requestInit = Object.assign({}, requestInit, { body: enrichPaymentBody(requestInit.body) });
      }

      return originalFetch.call(this, input, requestInit).then(function (response) {
        if (isPaymentCreate || isPaymentStatus) {
          response.clone().json().then(function (body) {
            trackPaymentResponse(body, response.status, isPaymentCreate);
          }).catch(function () {});
        }
        return response;
      }, function (error) {
        if (isPaymentCreate) track('payment_failed', { message: error && error.message ? error.message : 'fetch_failed' });
        throw error;
      });
    };
  }

  function patchXhr() {
    if (!window.XMLHttpRequest) return;
    var originalOpen = XMLHttpRequest.prototype.open;
    var originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      this.__apoloAnalyticsUrl = url;
      this.__apoloAnalyticsMethod = method;
      return originalOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
      var url = this.__apoloAnalyticsUrl;
      var isPaymentCreate = isPaymentCreateUrl(url);
      var isPaymentStatus = isPaymentStatusUrl(url);
      if (isPaymentCreate) {
        track('payment_create_started', { url: String(url).slice(0, 300), transport: 'xhr' });
        body = enrichPaymentBody(body);
      }
      if (isPaymentCreate || isPaymentStatus) {
        this.addEventListener('load', function () {
          try {
            trackPaymentResponse(JSON.parse(this.responseText || '{}'), this.status, isPaymentCreate);
          } catch (_) {
            if (isPaymentCreate && this.status >= 400) track('payment_failed', { httpStatus: this.status, transport: 'xhr' });
          }
        });
      }
      return originalSend.call(this, body);
    };
  }

  function bindVideos() {
    Array.prototype.forEach.call(document.querySelectorAll('video'), function (video, index) {
      track('video_impression', { index: index, src: cleanText(video.currentSrc || video.src, 500) });
      video.addEventListener('play', function () { track('video_play', { index: index, currentTime: Math.round(video.currentTime || 0) }); });
      video.addEventListener('pause', function () {
        var progress = video.duration ? Math.round((video.currentTime / video.duration) * 100) : 0;
        track('video_pause', { index: index, progress: progress, currentTime: Math.round(video.currentTime || 0) });
      });
      video.addEventListener('ended', function () { track('video_complete', { index: index }); });
      video.addEventListener('timeupdate', function () {
        if (!video.duration) return;
        var progress = Math.round((video.currentTime / video.duration) * 100);
        var seen = videoMilestones.get(video) || {};
        [10, 25, 50, 75, 90].forEach(function (milestone) {
          if (progress >= milestone && !seen[milestone]) {
            seen[milestone] = true;
            track('video_milestone_' + milestone, { index: index, progress: milestone });
          }
        });
        videoMilestones.set(video, seen);
      });
    });
  }

  // ---------------------------------------------------------------------
  // Captura de lead. Caminho TOTALMENTE separado da fila de analytics: o
  // payload com email nunca entra em "queue" nem em localStorage, e em caso de
  // falha nao e' reenfileirado - PII nao pode ficar guardada no navegador
  // esperando retry.
  // ---------------------------------------------------------------------
  var emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function fieldValue(form, selectors, storageKeys) {
    for (var i = 0; i < selectors.length; i += 1) {
      var node = form && form.querySelector ? form.querySelector(selectors[i]) : null;
      if (node && node.value && String(node.value).trim()) return String(node.value).trim();
    }
    for (var j = 0; j < storageKeys.length; j += 1) {
      var stored = storageGet(localStorage, storageKeys[j]);
      if (stored && String(stored).trim()) return String(stored).trim();
    }
    return '';
  }

  function captureLead(form) {
    // O handleSubmit inline das paginas so grava no localStorage; por isso os
    // seletores do form vem primeiro e o storage entra como fallback.
    var email = fieldValue(form, ['input[type="email"]', '#emailInput', 'input[name="email"]'], ['email']);
    if (!email || !emailPattern.test(email)) return;

    var lastSent = storageGet(sessionStorage, 'apolo_lead_last');
    if (lastSent === email.toLowerCase()) return;
    storageSet(sessionStorage, 'apolo_lead_last', email.toLowerCase());

    var phone = fieldValue(form, ['input[type="tel"]', '#phoneInput', 'input[name="phone"]'], ['telefone', 'telephone', 'phone']);
    var name = fieldValue(form, ['input[name="name"]', '#nameInput', '#nomeCompleto'], ['nome', 'name', 'nomeCompleto']);

    try {
      fetch(leadEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          project: project,
          email: email,
          name: name || undefined,
          phone: phone || undefined,
          visitorId: visitorId,
          sessionId: sessionId,
          journeyId: journeyId,
          formId: (form && form.id) || undefined,
          path: location.pathname,
          pageUrl: location.href,
          utm: getUtms()
        }),
        keepalive: true,
        credentials: 'omit'
      }).catch(function () {});
    } catch (_) {}

    // Sinal anonimo para o funil - sem nenhum dado pessoal.
    // As chaves evitam de proposito as palavras "email"/"phone": o
    // sanitizeJsonValue do analytics casa por substring, entao "hasEmail"
    // seria descartado junto com os campos que realmente carregam PII.
    track('lead_captured', { captured: true, tel: Boolean(phone), formId: cleanText(form && form.id, 80) });
  }

  document.addEventListener('click', function (event) {
    var target = event.target && event.target.closest ? event.target.closest('a,button,[role="button"],input[type="button"],input[type="submit"],[data-value],[data-v],[data-day],[data-t],[data-n]') : null;
    if (!target) return;
    var classified = classifyClick(target);
    track(classified.name, {
      tag: target.tagName,
      id: cleanText(target.id, 80),
      label: elementLabel(target),
      href: cleanText(target.href, 500),
      value: classified.value,
      selector: classified.attr
    });
  }, true);

  document.addEventListener('submit', function (event) {
    var form = event.target;
    track(formEventName(form), { id: cleanText(form && form.id, 80), fields: form && form.elements ? form.elements.length : 0 });
    captureLead(form);
  }, true);

  document.addEventListener('blur', function (event) {
    var target = event.target;
    if (!target || !/INPUT|SELECT|TEXTAREA/.test(target.tagName)) return;
    var type = (target.type || target.tagName || '').toLowerCase();
    track('field_blur', {
      field: cleanText(target.id || target.name || type, 100),
      type: type,
      completed: Boolean(target.value),
      valid: typeof target.checkValidity === 'function' ? target.checkValidity() : undefined
    });
    if (typeof target.checkValidity === 'function' && !target.checkValidity()) {
      track('validation_error', { field: cleanText(target.id || target.name || type, 100), type: type });
    }
  }, true);

  window.addEventListener('scroll', function () {
    var scrollTop = window.scrollY || document.documentElement.scrollTop || 0;
    var height = Math.max(document.documentElement.scrollHeight - window.innerHeight, 1);
    var progress = Math.round((scrollTop / height) * 100);
    [25, 50, 75, 90].forEach(function (milestone) {
      if (progress >= milestone && !scrollMilestones[milestone]) {
        scrollMilestones[milestone] = true;
        track('scroll_depth', { progress: milestone });
      }
    });
  }, { passive: true });

  window.addEventListener('error', function (event) {
    if (event.target && event.target !== window) {
      var target = event.target;
      track('resource_error', {
        tag: cleanText(target.tagName || '', 40),
        id: cleanText(target.id || '', 80),
        source: cleanText(target.src || target.href || target.currentSrc || '', 800)
      });
      return;
    }
    var message = cleanText(event.message || '', 300) || 'Erro JS sem mensagem';
    track('js_error', {
      message: message,
      filename: cleanText(event.filename || '', 500),
      line: event.lineno || 0,
      column: event.colno || 0,
      type: cleanText(event.type || '', 80)
    });
  });

  window.addEventListener('unhandledrejection', function (event) {
    var reason = event.reason;
    var message = reason && reason.message ? reason.message : reason ? String(reason) : 'unhandledrejection';
    track('js_error', { message: cleanText(message, 300), type: 'unhandledrejection' });
  });

  window.addEventListener('pagehide', function () {
    track('page_leave', { durationMs: Math.round(performance.now()) });
    flush(true);
  });

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flush(true);
  });

  patchFetch();
  patchXhr();
  track('page_view', { loadState: document.readyState });
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindVideos, { once: true });
  } else {
    bindVideos();
  }
})();
