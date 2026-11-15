/*
 * LINEの問い合わせ受付（Google Apps Script 側の入口）
 *
 * このファイルは設計を示すための見本です。公開デモでは動かしていません。
 * 判定は core.js（同じプロジェクトに置く）の関数をそのまま使います。
 *
 * 鍵の置き場所：スクリプトプロパティ（コードには書かない）
 *   LINE_CHANNEL_SECRET / LINE_CHANNEL_TOKEN / AI_API_KEY / AI_API_URL / LEDGER_SHEET_ID
 * 権限：appsscript.json の oauthScopes を次の2つに絞る
 *   https://www.googleapis.com/auth/spreadsheets
 *   https://www.googleapis.com/auth/script.external_request
 *   実行は台帳専用のアカウントで行い、そのアカウントには台帳1冊だけを共有する。
 *
 * 確認事項（未実装）：
 *   - GASのWebアプリは受信ヘッダーを読めないため、署名検証は前段の中継（Cloud Functions等）で行う。
 *     verifyAndForward_ はその中継側の処理を同じ言葉で書いたもの。
 *   - 氏名は正規表現では拾いきれない。AIへ渡す範囲は、導入前に取り決める。
 */

function props_() {
  return PropertiesService.getScriptProperties();
}

/** 中継側：署名が合わない通信はここで捨てる（本文は読まない・残さない） */
function verifyAndForward_(rawBody, signatureHeader) {
  var mac = Utilities.computeHmacSha256Signature(rawBody, props_().getProperty('LINE_CHANNEL_SECRET'));
  var expected = Utilities.base64Encode(mac);
  if (!InquiryCore.safeEqual(expected, signatureHeader)) {
    console.warn('署名不一致のため破棄'); // 本文はログに出さない
    return false;
  }
  return true;
}

/** 受信：1件ずつ 伏せ字 → AI → 検査 → 振り分け → 台帳 */
function doPost(e) {
  var body = JSON.parse(e.postData.contents);
  (body.events || []).forEach(function (ev) {
    if (ev.type !== 'message' || ev.message.type !== 'text') return;
    var masked = InquiryCore.maskPII(ev.message.text);
    var parsed = InquiryCore.parseAiResponse(callAi_(InquiryCore.buildPrompt(masked.text)));
    var route = InquiryCore.decideRoute(parsed);
    var row = InquiryCore.buildLedgerRow(Utilities.getUuid().slice(0, 8), new Date(), masked.text, parsed, route);
    appendLedger_(row, ev.source.userId);
  });
  return ContentService.createTextOutput('ok');
}

function callAi_(prompt) {
  try {
    var res = UrlFetchApp.fetch(props_().getProperty('AI_API_URL'), {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + props_().getProperty('AI_API_KEY') },
      payload: JSON.stringify({ input: prompt }),
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) return ''; // 失敗は「検査を通らない応答」として手作業へ回る
    return JSON.parse(res.getContentText()).output;
  } catch (err) {
    console.error('AI呼び出し失敗: ' + err.name); // 指示文・本文はログに出さない
    return '';
  }
}

function appendLedger_(row, lineUserId) {
  var sh = SpreadsheetApp.openById(props_().getProperty('LEDGER_SHEET_ID')).getSheetByName('台帳');
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    sh.appendRow([row.id, row.receivedAt, row.text, row.category, row.urgent, row.assignee, row.status, row.draft, '', '', lineUserId]);
  } finally {
    lock.releaseLock();
  }
}

/** 送信：担当者が台帳の画面で確認したときだけ呼ばれる。AIが自動で送ることはない */
function sendApproved_(row, approver, finalText, lineUserId) {
  var done = InquiryCore.approve(row, approver, finalText, new Date());
  if (!done.ok) throw new Error(done.reason);
  UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + props_().getProperty('LINE_CHANNEL_TOKEN') },
    payload: JSON.stringify({ to: lineUserId, messages: [{ type: 'text', text: done.row.draft }] })
  });
  return done.row;
}
