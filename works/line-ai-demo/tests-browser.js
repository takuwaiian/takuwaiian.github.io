/* 画面の中で実行するテスト。Node.js 版（core.test.js）と同じ24件・同じ番号。 */
(function (root) {
  'use strict';
  function run(C, hmac) {
    var J = JSON.stringify;
    var p = { ok: true, category: '見積依頼', urgent: false, draft: '下書き' };
    var sync = [
      ['T01 伏せ字：電話・メール・郵便番号・番地が本文から消える', function () {
        var r = C.maskPII('山田です。090-0000-0000 か test@example.com へ。〒123-4567 架空市1丁目2番3号です。');
        return !/090|example\.com|123-4567|1丁目/.test(r.text) && J(r.found.slice().sort()) === J(['メール', '番地', '郵便番号', '電話'].sort());
      }],
      ['T02 伏せ字：全角の数字で書かれた電話番号も消える', function () {
        return !/0000|００００/.test(C.maskPII('電話は０９０－００００－００００です').text);
      }],
      ['T03 伏せ字：個人情報がなければ本文は変わらない', function () {
        var r = C.maskPII('蛇口から水が漏れています');
        return r.text === '蛇口から水が漏れています' && r.found.length === 0;
      }],
      ['T04 伏せ字：空や未定義でも落ちない', function () {
        return C.maskPII(undefined).text === '' && C.maskPII('').text === '';
      }],
      ['T09 指示文：伏せ字前の個人情報が入らない', function () {
        return C.buildPrompt(C.maskPII('090-0000-0000 に電話ください').text).indexOf('090-0000-0000') === -1;
      }],
      ['T10 AI応答：正しい形は通る', function () {
        var r = C.parseAiResponse('{"category":"見積依頼","urgent":false,"draft":"確認して折り返します。"}');
        return r.ok === true && r.category === '見積依頼';
      }],
      ['T11 AI応答：コードブロックで囲まれていても読める', function () {
        return C.parseAiResponse('```json\n{"category":"その他","urgent":false,"draft":"承知しました。"}\n```').ok === true;
      }],
      ['T12 AI応答：JSONでなければ通さない', function () {
        return C.parseAiResponse('見積依頼だと思います').ok === false;
      }],
      ['T13 AI応答：一覧にない分類は通さない', function () {
        return C.parseAiResponse('{"category":"営業","urgent":false,"draft":"a"}').ok === false;
      }],
      ['T14 AI応答：至急が文字列なら通さない', function () {
        return C.parseAiResponse('{"category":"その他","urgent":"yes","draft":"a"}').ok === false;
      }],
      ['T15 AI応答：下書きが空・長すぎるものは通さない', function () {
        var long = new Array(C.DRAFT_MAX + 2).join('あ');
        return C.parseAiResponse('{"category":"その他","urgent":false,"draft":" "}').ok === false &&
          C.parseAiResponse(J({ category: 'その他', urgent: false, draft: long })).ok === false;
      }],
      ['T16 AI応答：金額や訪問の約束が入った下書きは通さない', function () {
        return C.parseAiResponse('{"category":"料金の質問","urgent":false,"draft":"8,000円で承ります。"}').ok === false &&
          C.parseAiResponse('{"category":"見積依頼","urgent":true,"draft":"本日中に伺います。"}').ok === false;
      }],
      ['T17 AI応答：リンクが入った下書きは通さない', function () {
        return C.parseAiResponse('{"category":"その他","urgent":false,"draft":"こちらへ https://example.com"}').ok === false;
      }],
      ['T18 AI応答：配列やnullは通さない', function () {
        return C.parseAiResponse('[]').ok === false && C.parseAiResponse('null').ok === false;
      }],
      ['T19 振り分け：クレームは責任者へ回し、AIの下書きを使わない', function () {
        var r = C.decideRoute({ ok: true, category: 'クレーム', urgent: true, draft: 'x' });
        return r.assignee === '責任者' && r.useDraft === false;
      }],
      ['T20 振り分け：至急は当番へ', function () {
        var r = C.decideRoute({ ok: true, category: '見積依頼', urgent: true, draft: 'x' });
        return r.assignee === '当番' && r.useDraft === true;
      }],
      ['T21 振り分け：検査を通らなかった応答は手作業に回す', function () {
        var r = C.decideRoute({ ok: false, reason: 'x' });
        return r.useDraft === false && r.status === '手作業で対応';
      }],
      ['T22 台帳：下書きを使わない行には下書きが残らない', function () {
        var q = { ok: true, category: 'クレーム', urgent: false, draft: 'AIの文' };
        return C.buildLedgerRow('Q-001', 't', '本文', q, C.decideRoute(q)).draft === '';
      }],
      ['T23 送信：確認者と返信文がそろったときだけ送信済みになる', function () {
        var row = C.buildLedgerRow('Q-002', 't', '本文', p, C.decideRoute(p));
        var done = C.approve(row, '佐藤', '直した文', 't2');
        return C.approve(row, '', '文', 't2').ok === false && C.approve(row, '佐藤', '  ', 't2').ok === false &&
          done.row.status === '送信済み' && done.row.draft === '直した文' && row.status === '確認待ち';
      }],
      ['T24 送信：送信済みの行は二重に送れない', function () {
        var row = C.buildLedgerRow('Q-003', 't', '本文', p, C.decideRoute(p));
        return C.approve(C.approve(row, '佐藤', '文', 't2').row, '佐藤', '文', 't3').ok === false;
      }]
    ];

    function safe(fn) { try { return fn() === true; } catch (e) { return false; } }
    var results = sync.map(function (t) { return { name: t[0], pass: safe(t[1]) }; });

    var body = '{"events":[]}';
    return Promise.all([hmac('secret', body), hmac('secret', body), hmac('secret', '{"events":[ ]}'), hmac('other', body)])
      .then(function (s) {
        return [
          { name: 'T05 署名：正しい署名は通る', pass: C.safeEqual(s[0], s[1]) === true },
          { name: 'T06 署名：本文が1文字でも変わると通らない', pass: C.safeEqual(s[0], s[2]) === false },
          { name: 'T07 署名：鍵が違うと通らない', pass: C.safeEqual(s[0], s[3]) === false },
          { name: 'T08 署名：署名なし・長さ違いは通らない', pass: C.safeEqual(undefined, s[0]) === false && C.safeEqual('', s[0]) === false && C.safeEqual('abc', 'abcd') === false }
        ];
      })
      .catch(function () {
        return ['T05', 'T06', 'T07', 'T08'].map(function (n) { return { name: n + ' 署名（この環境では計算できません）', pass: false }; });
      })
      .then(function (sig) {
        return results.concat(sig).sort(function (a, b) { return a.name < b.name ? -1 : 1; });
      });
  }
  root.InquiryTests = { run: run };
})(typeof globalThis !== 'undefined' ? globalThis : this);
