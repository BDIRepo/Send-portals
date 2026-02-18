// ==UserScript==
// @id             iitc-plugin-send-comm-local
// @name           IITC plugin: Send COMM to local API (raw)
// @category       Info
// @updateURL      https://github.com/BDIRepo/Send-portals/raw/master/send-comm.meta.js
// @downloadURL    https://github.com/BDIRepo/Send-portals/raw/master/send-comm.user.js
// @version        0.2.5
// @description    Send ALL COMM raw events ([guid, ts_ms, {plext}]) to local FastAPI via GM_xmlhttpRequest
// @match          https://intel.ingress.com/*
// @grant          GM_xmlhttpRequest
// @grant          unsafeWindow
// @connect        srv42.mikr.us:20214
// @connect        srv42.mikr.us
// ==/UserScript==