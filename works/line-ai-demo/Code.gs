/*
 * LINEの問い合わせ受付（Google Apps Script 側の入口）
 *
 * このファイルは設計を示すための見本です。公開デモでは動かしていません（実機での動作確認もしていません）。
 * 判定は core.js（同じプロジェクトに置く）の関数をそのまま使います。
 *
 * 鍵の置き場所：スクリプトプロパティ（コードには書かない）
 *   LINE_CHANNEL_SECRET / LINE_CHANNEL_TOKEN / AI_API_KEY / AI_API_URL / LEDGER_SHEET_ID / RELAY_TOKEN
 * 権限：appsscript.json の oauthScopes を次の2つに絞る
 *   https://www.googleapis.com/auth/spreadsheets
 *   https://www.googleapis.com/auth/script.external_request
 *   実行は台帳専用のアカウントで行い、そのアカウントには台帳1冊だけを共有する。
 *
 * 確認事項（未実装・導入前に決めること）：
 *   - GASのWebアプリは受信ヘッダーを読めないため、署名検証は前段の中継（Cloud Functions等）で行う。
 *     verifyAndForward_ は、中継でやる処理をGASの書き方で示した擬似コード。中継の環境にそのままは移せない。
 *   - 中継からGASへは、共有の合言葉（RELAY_TOKEN）を付けて渡す。URLを知っているだけの第三者は受け付けない。
 *     合言葉をURLに付ける方式は記録に残りやすいので、渡し方は中継の構成とあわせて決める。
 *   - LINEが同じ通信を送り直した場合の重複よけ（webhookEventId の記録）は入れていない。
 *   - 氏名は正規表現では拾いきれない。AIへ渡す範囲は、導入前に取り決める。
 *   - 確認者が誰かは、台帳の画面を開けるアカウントで絞る（approve は名前が空でないことしか見ない）。
 */

function props_() {
  return PropertiesService.getScriptProperties();
}

/** 中継側（擬似コード）：署名が合わない通信はここで捨てる（本文は読まない・残さない） */
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
  var token = (e.parameter && e.parameter.token) || '';
  if (!InquiryCore.safeEqual(props_().getProperty('RELAY_TOKEN'), token)) {
    return ContentService.createTextOutput('ng'); // 中継を通っていない通信は処理しない
  }
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return ContentService.createTextOutput('ng');
  }
  (body.events || []).forEach(function (ev) {
    try {
      if (ev.type !== 'message' || !ev.message || ev.message.type !== 'text') return;
      if (!ev.source || !ev.source.userId) return; // 返信の宛先が分からない通信（グループ等）は扱わない
      var masked = InquiryCore.maskPII(ev.message.text);
      var parsed = InquiryCore.parseAiResponse(callAi_(InquiryCore.buildPrompt(masked.text)));
      var route = InquiryCore.decideRoute(parsed);
      // 番号は英字で始める（数字だけだと、シートが数値に変えてしまい、あとで行を探せなくなる）
      var row = InquiryCore.buildLedgerRow('Q-' + Utilities.getUuid().slice(0, 8), new Date(), masked.text, parsed, route);
      appendLedger_(row, ev.source.userId);
    } catch (err) {
      console.error('受信処理に失敗: ' + err.name); // 1件の失敗でほかの通信を止めない。本文はログに出さない
    }
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

function ledger_() {
  return SpreadsheetApp.openById(props_().getProperty('LEDGER_SHEET_ID')).getSheetByName('台帳');
}

/** 台帳の列：A番号 B受信 C本文 D分類 E至急 F担当 G状態 H返信文 I確認者 J送信時刻 K宛先 */
function appendLedger_(row, lineUserId) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    // 客の本文やAIの下書きが「=」などで始まっても、数式として実行させない
    var cells = [row.id, row.receivedAt, row.text, row.category, row.urgent, row.assignee, row.status, row.draft, '', '', lineUserId];
    ledger_().appendRow(cells.map(InquiryCore.sanitizeCell));
  } finally {
    lock.releaseLock();
  }
}

/**
 * 送信：担当者が台帳の画面で確認したときに呼ぶ。AIが自動で送ることはない。
 * 二重送信を防ぐため、ロックを取ってから台帳の行を読み直し、状態を確かめる。
 * 送る前に「送信中」と書き、送れたら「送信済み」、LINEに断られたら元の状態へ戻す。
 * 送信のあとの書き込みや通信が途中で落ちた行は「送信中」のまま残る。その行は送り直せないので、人が確かめる。
 * 宛先も台帳から読む（呼び出し側から受け取らない）。
 */
function sendApproved_(id, approver, finalText) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sh = ledger_();
    var ids = sh.getRange(2, 1, Math.max(sh.getLastRow() - 1, 1), 1).getValues();
    var at = -1;
    for (var i = 0; i < ids.length; i++) { if (String(ids[i][0]) === String(id)) { at = i + 2; break; } }
    if (at === -1) throw new Error('台帳に該当の行がない');
    var v = sh.getRange(at, 1, 1, 11).getValues()[0];
    var done = InquiryCore.approve({ id: v[0], status: v[6], draft: v[7] }, approver, finalText, new Date());
    if (!done.ok) throw new Error(done.reason); // 送信済み・送信中なら、ここで止まる
    if (!v[10]) throw new Error('宛先が台帳にない');
    sh.getRange(at, 7).setValue('送信中');
    SpreadsheetApp.flush();
    var res =UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + props_().getProperty('LINE_CHANNEL_TOKEN') },
      payload: JSON.stringify({ to: v[10], messages: [{ type: 'text', text: done.row.draft }] }),
      muteHttpExceptions: true
    });
    if (res.getResponseCode() !== 200) {
      sh.getRange(at, 7).setValue(InquiryCore.sanitizeCell(String(v[6]))); // LINEに断られた＝送れていないので、元の状態へ戻す
      throw new Error('LINEへの送信に失敗（台帳は元の状態に戻した）');
    }
    sh.getRange(at, 7, 1, 4).setValues([[done.row.status, done.row.draft, done.row.sentBy, done.row.sentAt]].map(function (r) {
      return r.map(InquiryCore.sanitizeCell);
    }));
    return done.row.status;
  } finally {
    lock.releaseLock();
  }
}
