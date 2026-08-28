const path = require('path');
const fs = require('fs');

// .envファイルを直接読み込んでprocess.envに設定（dotenvのoverride問題回避）
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) {
      process.env[match[1].trim()] = match[2].trim();
    }
  }
}

const express = require('express');
const { Readable } = require('stream');
const Anthropic = require('@anthropic-ai/sdk');
const { google } = require('googleapis');

// フォームの内部コードをPDF・表示用の日本語ラベルに変換する対応表
const COOKING_METHOD_LABELS = {
  grill: '焼く', boil: '煮る', steam: '蒸す', fry: '揚げる',
  season: '味付けする', pour: 'カップに注ぐ', plate: 'よそう（盛り付ける）',
};
const STORAGE_LABELS = { normal: '常温', cold: '冷蔵（クーラーBOX等）', frozen: '冷凍' };
const SERVE_METHOD_LABELS = { disposable: '使い捨て容器にて提供', cup: '使い捨てカップにて提供' };

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// 国内仕入れ先チェック用（簡易・完全ではない）
const OVERSEAS_KEYWORDS = ['中国', 'アメリカ', 'USA', '韓国', '台湾', 'ベトナム', 'タイ', 'インド', 'フランス', 'イタリア', '海外'];
// 使用不可の材料キーワード
const BANNED_INGREDIENT_KEYWORDS = ['牛乳', '生乳', '白米'];
// 曖昧な調理表現
const VAGUE_COOKING_PHRASES = ['温める', '熱湯を注ぐ', 'あたためる'];
// 自家調合ドリンク（清涼飲料水製造業の許可が必要になるパターン）
const SELF_MADE_DRINK_KEYWORDS = ['シロップ', 'コーディアル', '自家製ドリンク', '自家調合', '自家製シロップ'];
// 生のまま提供されやすい／加熱が前提の食材（保健所確認済み：生のまま提供は不可）
const RAW_OR_HEAT_NEEDED_KEYWORDS = ['きゅうり', 'レタス', 'トマト', 'キャベツ', '水菜', 'パクチー', 'もやし', 'レモン', '生野菜', '生の野菜', '生の果物', '焼きそば', 'そば', 'うどん', 'ラーメン', 'パスタ', '麺', '豚肉', '鶏肉', '牛肉', 'ひき肉', '魚', 'エビ', 'イカ', 'タコ', '卵'];
// 実際に加熱する調理方法（これ以外は「加熱した」と見なさない）
const HEAT_COOKING_METHODS = ['grill', 'boil', 'steam', 'fry'];
// 常温保存でも問題ない食品（これに該当しなければ常温は警告対象）
const DRY_SAFE_KEYWORDS = ['乾麺', '乾き物', '乾物', 'せんべい', 'クッキー', 'ビスケット', '飴', 'キャンディ', 'ポップコーン', 'スナック', 'ドライフルーツ', '焼き菓子', '駄菓子', 'チップス', 'ナッツ'];

function isBlank(v) {
  return v === undefined || v === null || String(v).trim() === '';
}

function containsAny(text, keywords) {
  if (!text) return null;
  const hit = keywords.find((k) => text.includes(k));
  return hit || null;
}

// 取扱食品名に複数品目が書かれていないかの簡易判定（空白・読点・カンマで区切られていたら複数扱い）
function looksLikeMultipleItems(text) {
  if (!text) return false;
  return /[\s,、]/.test(text.trim());
}

// ===== 決定的バリデーション（構造・必須項目・既知NGパターン） =====
function validateSubmission(d) {
  const errors = {};

  // 共通項目
  if (isBlank(d.address)) errors.address = '出店者の住所を入力してください。';
  if (isBlank(d.shopName)) errors.shopName = '店名を入力してください。';
  if (isBlank(d.personName)) errors.personName = '担当者の個人名を入力してください（法人名・屋号だけではNGです）。';
  if (isBlank(d.phone)) {
    errors.phone = '電話番号を入力してください。';
  } else if (!/^[0-9\-]{9,13}$/.test(d.phone.trim())) {
    errors.phone = '電話番号の形式が正しくありません（例：03-1234-5678）。';
  }
  if (isBlank(d.email)) {
    errors.email = 'メールアドレスを入力してください。';
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email.trim())) {
    errors.email = 'メールアドレスの形式が正しくありません。';
  }
  if (isBlank(d.cumulativeDays)) {
    errors.cumulativeDays = '本年度の累計出店日数を入力してください。';
  } else if (!/^[0-9]+$/.test(String(d.cumulativeDays).trim())) {
    errors.cumulativeDays = '累計出店日数は数字で入力してください。';
  }

  if (d.businessType !== 'restaurant' && d.businessType !== 'retail') {
    errors.businessType = '「飲食店（その場で調理して提供）」か「食品物販（完成品を販売するのみ）」のどちらか一方を選んでください。';
  }

  if (d.businessType === 'restaurant') {
    if (isBlank(d.foodName)) {
      errors.foodName = '取扱食品名を入力してください。';
    } else if (looksLikeMultipleItems(d.foodName)) {
      errors.foodName = '取扱食品名は1品のみ記載してください。複数書くと許可が通りません。';
    }
    if (isBlank(d.servingCount)) {
      errors.servingCount = '提供数を入力してください。';
    } else if (!/^[0-9]+$/.test(String(d.servingCount).trim())) {
      errors.servingCount = '提供数は数字で入力してください。';
    }

    const ingredients = (d.ingredients || []).filter((ing) => !isBlank(ing));
    if (ingredients.length === 0) {
      errors.ingredients = '使う食材を1つ以上入力してください。';
    } else {
      for (const ing of ingredients) {
        const banned = containsAny(ing, BANNED_INGREDIENT_KEYWORDS);
        if (banned) {
          errors.ingredients = `「${banned}」は臨時出店では使用できません。オーツミルク・豆乳など代替品に変更してください。`;
          break;
        }
      }
    }

    if (d.ingredientSourceType !== 'purchase' && d.ingredientSourceType !== 'selfmade') {
      errors.ingredientSourceType = '食材について「購入する」か「保健所許可のある場所で自家製造する」のどちらかを選んでください。';
    } else if (d.ingredientSourceType === 'purchase') {
      if (isBlank(d.ingredientSourceName)) errors.ingredientSourceName = '購入先の名前を入力してください（市販品でも必須です）。';
      if (isBlank(d.ingredientSourceAddress)) {
        errors.ingredientSourceAddress = '購入先の住所を入力してください。';
      } else {
        const overseas = containsAny(d.ingredientSourceAddress, OVERSEAS_KEYWORDS);
        if (overseas) {
          errors.ingredientSourceAddress = `購入先住所に「${overseas}」が含まれています。国内の仕入れ先の名前・住所を記載してください。`;
        }
      }
    }

    if (d.prep !== 'onsite' && d.prep !== 'none') {
      errors.prep = '仕込みについて「当日仕込みあり」か「仕込みなし」のどちらかを選んでください。';
    } else if (d.prep === 'onsite') {
      if (isBlank(d.prepFacilityName) || isBlank(d.prepFacilityAddress)) {
        errors.prepFacility = '仕込みを行う施設の名称と住所を入力してください。';
      }
      if (isBlank(d.prepDetail)) {
        errors.prepDetail = '当日仕込み内容を具体的に入力してください。';
      }
    }

    if (!d.cookingMethod) {
      errors.cookingMethod = '調理方法を1つ選んでください（2種類以上は選べません）。';
    } else if (d.cookingMethod === 'boil') {
      errors.cookingMethod = '大量の水を使う調理（茹でる）は臨時出店の設備では認められません。他の調理方法に変更してください。';
    } else if (d.cookingMethod === 'other') {
      if (isBlank(d.cookingMethodOther)) {
        errors.cookingMethodOther = '「その他」を選んだ場合は具体的な調理方法を入力してください。';
      } else {
        const vague = containsAny(d.cookingMethodOther, VAGUE_COOKING_PHRASES);
        if (vague && d.cookingMethodOther.trim().length < 12) {
          errors.cookingMethodOther = `「${vague}」だけでは曖昧です。「十分に加熱する」「市販のティーバッグで一杯ずつ抽出する」のように具体的な工程を明記してください。`;
        }
      }
    }

    if (!d.storage) errors.storage = '保存方法を選んでください。';
    if (d.storage === 'other' && isBlank(d.storageOther)) {
      errors.storageOther = '保存方法の「その他」の内容を入力してください。';
    }
    if (d.storage === 'normal' && !errors.foodName) {
      const dryHit = containsAny([d.foodName, ...(d.ingredients || [])].filter(Boolean).join(' '), DRY_SAFE_KEYWORDS);
      if (!dryHit) {
        errors.storage = '常温保存が適さない可能性があります。乾麺・乾き物など水分が少なく傷みにくい食品でなければ、冷蔵または冷凍を選んでください。';
      }
    }

    if (!d.serveMethod || d.serveMethod.length === 0) {
      errors.serveMethod = '提供方法を1つ以上選んでください。';
    } else if (d.serveMethod.includes('other') && isBlank(d.serveMethodOther)) {
      errors.serveMethodOther = '「その他」を選んだ場合は提供方法を具体的に入力してください。';
    }

    // 自家調合ドリンク（シロップ等を炭酸水・水で割るもの）は清涼飲料水製造業の許可が必要になる
    if (!errors.ingredients && !errors.cookingMethodOther) {
      const drinkText = [d.foodName, ...(d.ingredients || []), d.cookingMethodOther].filter(Boolean).join(' ');
      const drinkHit = containsAny(drinkText, SELF_MADE_DRINK_KEYWORDS);
      if (drinkHit) {
        errors.ingredients = `「${drinkHit}」を使う自家調合ドリンクは、清涼飲料水製造業の許可が必要になります。この許可を取っていない場合は、市販品をそのまま小分けにする、または市販のティーバッグ・ドリップバッグで一杯ずつ抽出する方法に変更してください。`;
      }
    }

    // 生のまま提供されやすい／加熱が前提の食材なのに、実際に加熱する調理方法が選ばれていない
    if (!errors.ingredients && !errors.cookingMethod) {
      const rawText = [d.foodName, ...(d.ingredients || [])].filter(Boolean).join(' ');
      const rawHit = containsAny(rawText, RAW_OR_HEAT_NEEDED_KEYWORDS);
      if (rawHit && !HEAT_COOKING_METHODS.includes(d.cookingMethod)) {
        errors.cookingMethod = `「${rawHit}」は加熱調理が必要な食材の可能性があります。保健所の確認では生のまま提供することはできません。調理方法で「焼く」「煮る」「蒸す」「揚げる」のいずれかを選んでください。`;
      }
    }
  }

  if (d.businessType === 'retail') {
    if (isBlank(d.foodName)) {
      errors.foodName = '取扱食品名を入力してください。';
    } else if (looksLikeMultipleItems(d.foodName)) {
      errors.foodName = '取扱食品名は1品のみ記載してください。複数書くと許可が通りません。';
    }
    if (isBlank(d.supplierName)) errors.supplierName = '仕入先の名前を入力してください。';

    if (d.selfMade !== 'yes' && d.selfMade !== 'no') {
      errors.selfMade = '自社製造か他社からの仕入れかを選んでください。';
    } else if (d.selfMade === 'yes') {
      if (isBlank(d.facilityName) || isBlank(d.facilityAddress)) {
        errors.facility = '自社製造の場合、製造許可のある施設の名称と住所を両方入力してください。';
      }
    } else if (d.selfMade === 'no') {
      if (isBlank(d.supplierAddress)) {
        errors.supplierAddress = '仕入先の住所を入力してください。';
      } else {
        const overseas = containsAny(d.supplierAddress, OVERSEAS_KEYWORDS);
        if (overseas) {
          errors.supplierAddress = `仕入先住所に「${overseas}」が含まれています。国内の仕入れ先の名前・住所を記載してください。`;
        }
      }
    }

    if (!d.packagingConfirmed) {
      errors.packagingConfirmed = '「包装済み完成品を販売する（表示ラベルあり）」にチェックしてください。';
    }
    if (d.isFrozen && !d.frozenLabelConfirmed) {
      errors.frozenLabelConfirmed = '冷凍食品を扱う場合は「冷凍食品である旨の表示がある」ことを確認してチェックしてください。';
    }

    if (!d.storage) errors.storage = '保存方法を選んでください。';
    if (d.storage === 'other' && isBlank(d.storageOther)) {
      errors.storageOther = '保存方法の「その他」の内容を入力してください。';
    }
  }

  return errors;
}

// ===== AI意味チェック（構造では防げない食品衛生の妥当性判断） =====
async function aiSemanticCheck(d) {
  const systemPrompt = `あなたは目黒マルシェの「臨時出店届」の内容を確認する担当者です。
入力されたJSONの内容を見て、食品衛生上・記載内容として不自然・矛盾している点だけを指摘してください。
以下はすでに機械的にチェック済みなので、指摘不要です:
- 必須項目の空欄
- 業態区分の二重選択
- 禁止材料（牛乳・白米）の使用
- 茹でる調理（大量の水）
- 購入先の空欄・海外住所
- 自家調合ドリンク（シロップ・コーディアル系）の清涼飲料水製造業許可の指摘

指摘してほしいのは、たとえば以下のような機械的チェックをすり抜ける矛盾です:
- 食品名と調理方法が明らかに矛盾している（例：トーストと書いてあるのに調理方法が「蒸す」）
- 材料欄と調理方法の説明が食い違っている
- 冷凍食品を扱っているのに冷凍食品の表示に触れられていない
- その他、明らかに保健所で差し戻されそうな矛盾

生ハム・チーズ・海鮮・生野菜・生の果物など「要冷蔵の生食材」については、キーワードだけで機械的に禁止はしていません。以下の考え方で判断してください:
- 調理方法が「焼く／煮る／蒸す／揚げる」など加熱を伴うもので、その生食材が最終的に加熱される（例：グリルサンドの具として挟んで焼く）場合は問題視しない
- その生食材が加熱されずそのまま提供される（例：生野菜のみのサラダ、飲料に生の果物をそのまま入れる、生ハムの盛り合わせ等）場合は、要冷蔵管理が必要になる旨と、常温保存できる代替品への変更を検討するよう指摘する
- 判断がつかない場合は、指摘はせず「生のまま提供する部分がある場合は主催者に個別確認してください」という趣旨のみ添える程度に留める

問題がなければ items を空配列にしてください。過剰な指摘はしないでください（迷ったら指摘しない）。

必ず以下のJSON形式のみで返答してください:
{
  "items": [
    { "field": "該当するフィールド名（自由記述可、日本語で分かる名前でよい）", "message": "具体的な指摘内容と直し方" }
  ]
}`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    system: systemPrompt,
    messages: [
      { role: 'user', content: `以下の入力内容を確認してください。\n\n${JSON.stringify(d, null, 2)}` },
    ],
  });

  const text = response.content[0].text.trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { items: [] };
  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    return { items: [] };
  }
}

// ===== Google Sheets 書き込み =====
async function writeToSheet(d, pdfLink) {
  if (!process.env.GOOGLE_CREDENTIALS_JSON) {
    console.log('GOOGLE_CREDENTIALS_JSON未設定 - スプレッドシート書き込みスキップ');
    return;
  }

  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const sheets = google.sheets({ version: 'v4', auth });
  const spreadsheetId = process.env.SPREADSHEET_ID;
  const sheetName = process.env.SHEET_NAME || '臨時出店フォーム受付';

  const row = [
    new Date().toISOString(),
    d.shopName,
    d.personName,
    d.phone,
    d.address,
    d.businessType === 'restaurant' ? '飲食店' : '食品物販',
    d.foodName,
    pdfLink || '',
    JSON.stringify(d),
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${sheetName}!A:I`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] },
  });
}

// ===== Gmail送信・PDF生成で共有するOAuth2クライアント =====
// (documents / drive / gmail.send スコープを持つ、micuscertus@gmail.comのトークン)
function getOAuth2Client() {
  if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_CLIENT_SECRET || !process.env.GMAIL_REFRESH_TOKEN) {
    return null;
  }
  const oAuth2Client = new google.auth.OAuth2(process.env.GMAIL_CLIENT_ID, process.env.GMAIL_CLIENT_SECRET);
  oAuth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  return oAuth2Client;
}

function getGmailClient() {
  const auth = getOAuth2Client();
  return auth ? google.gmail({ version: 'v1', auth }) : null;
}

// ===== 臨時出店届PDFの生成（テンプレートを複製→差し込み→PDF書き出し） =====
async function generateSubmissionPdf(d) {
  const auth = getOAuth2Client();
  if (!auth || !process.env.PDF_TEMPLATE_ID || d.businessType !== 'restaurant') {
    return null;
  }

  const docs = google.docs({ version: 'v1', auth });
  const drive = google.drive({ version: 'v3', auth });

  const copyRes = await drive.files.copy({
    fileId: process.env.PDF_TEMPLATE_ID,
    requestBody: {
      name: `臨時出店届_${d.shopName}`,
      parents: process.env.PDF_FOLDER_ID ? [process.env.PDF_FOLDER_ID] : undefined,
    },
  });
  const documentId = copyRes.data.id;

  const ingredients = d.ingredients || [];
  const replacements = {
    '{{住所}}': d.address,
    '{{氏名}}': `${d.shopName} ${d.personName}`,
    '{{電話番号}}': d.phone,
    '{{取扱食品}}': d.foodName,
    '{{提供数}}': d.servingCount,
    '{{材料1}}': ingredients[0] || '',
    '{{材料2}}': ingredients[1] || '',
    '{{材料3}}': ingredients[2] || '',
    '{{購入先名前}}': d.ingredientSourceType === 'selfmade' ? '自社（保健所許可施設で製造）' : d.ingredientSourceName,
    '{{購入先住所}}': d.ingredientSourceType === 'selfmade' ? '' : d.ingredientSourceAddress,
    '{{仕込み内容}}': d.prep === 'onsite' ? d.prepDetail : 'なし',
    '{{調理方法}}': COOKING_METHOD_LABELS[d.cookingMethod] || d.cookingMethodOther || '',
    '{{保存方法}}': STORAGE_LABELS[d.storage] || d.storageOther || '',
    '{{提供方法}}': (d.serveMethod || []).map((m) => SERVE_METHOD_LABELS[m] || d.serveMethodOther).join('、'),
    '{{累計出店日数}}': d.cumulativeDays,
  };

  await docs.documents.batchUpdate({
    documentId,
    requestBody: {
      requests: Object.entries(replacements).map(([placeholder, value]) => ({
        replaceAllText: { containsText: { text: placeholder, matchCase: true }, replaceText: value || '' },
      })),
    },
  });

  const exportRes = await drive.files.export(
    { fileId: documentId, mimeType: 'application/pdf' },
    { responseType: 'arraybuffer' }
  );

  const pdfName = `臨時出店届_${d.shopName}.pdf`;
  const pdfRes = await drive.files.create({
    requestBody: {
      name: pdfName,
      parents: process.env.PDF_FOLDER_ID ? [process.env.PDF_FOLDER_ID] : undefined,
    },
    media: { mimeType: 'application/pdf', body: Readable.from(Buffer.from(exportRes.data)) },
    fields: 'id, webViewLink',
  });

  await drive.files.delete({ fileId: documentId });

  return pdfRes.data.webViewLink;
}

function encodeHeaderWord(text) {
  return `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`;
}

function buildRawMessage({ fromName, fromEmail, to, subject, body }) {
  const from = `${encodeHeaderWord(fromName)} <${fromEmail}>`;
  const message = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodeHeaderWord(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    body,
  ].join('\r\n');
  return Buffer.from(message, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sendGmail({ fromName, fromEmail, to, subject, body }) {
  const gmail = getGmailClient();
  if (!gmail) {
    console.log('Gmail API設定が未設定 - メール送信をスキップ');
    return;
  }
  await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: buildRawMessage({ fromName, fromEmail, to, subject, body }) },
  });
}

// 主催者（自分）への通知メール
async function sendNotificationMail(d) {
  const businessTypeLabel = d.businessType === 'restaurant' ? '飲食店' : '食品物販';
  const body = `臨時出店届フォームに新しい申し込みがありました。

店名: ${d.shopName}
担当者: ${d.personName}
電話番号: ${d.phone}
メールアドレス: ${d.email}
住所: ${d.address}
業態区分: ${businessTypeLabel}
取扱食品名: ${d.foodName}

詳細はスプレッドシートを確認してください。`;

  await sendGmail({
    fromName: '目黒マルシェ自動処理',
    fromEmail: process.env.GMAIL_USER,
    to: process.env.ORGANIZER_EMAIL || process.env.GMAIL_USER,
    subject: `【臨時出店届】新規申し込み: ${d.shopName}`,
    body,
  });
}

// 出店者本人への受付完了メール（送信元はt@meguromarche.comとして送る）
async function sendConfirmationMail(d) {
  if (isBlank(d.email)) return;

  const body = `${d.shopName} ご担当者様

目黒マルシェ 臨時出店届フォームへのお申し込みを受け付けました。

店名: ${d.shopName}
担当者: ${d.personName}

内容を確認のうえ、必要があれば主催者よりご連絡いたします。
このメールに心当たりがない場合はお手数ですが破棄してください。

目黒マルシェ 事務局`;

  await sendGmail({
    fromName: '目黒マルシェ',
    fromEmail: 't@meguromarche.com',
    to: d.email,
    subject: '【目黒マルシェ】臨時出店届 受付完了のお知らせ',
    body,
  });
}

// ===== APIエンドポイント =====
app.post('/api/submit', async (req, res) => {
  try {
    const d = req.body || {};

    // 1. 決定的バリデーション
    const fieldErrors = validateSubmission(d);
    if (Object.keys(fieldErrors).length > 0) {
      return res.status(400).json({ ok: false, fieldErrors, stage: 'structure' });
    }

    // 2. AI意味チェック
    let aiResult = { items: [] };
    try {
      aiResult = await aiSemanticCheck(d);
    } catch (e) {
      console.error('AI check error:', e.message);
      // AIチェックが落ちても構造チェックが通っていれば受付は続行する
    }

    if (aiResult.items && aiResult.items.length > 0) {
      const aiErrors = {};
      aiResult.items.forEach((item, i) => {
        aiErrors[`ai_${i}_${item.field || 'other'}`] = item.message;
      });
      return res.status(422).json({ ok: false, fieldErrors: aiErrors, stage: 'semantic' });
    }

    // 3〜5. PDF生成→Sheets書き込み→メール送信（応答をブロックしないよう待たない。PDFのリンクをシートに残すためこの順で行う）
    (async () => {
      let pdfLink = null;
      try {
        pdfLink = await generateSubmissionPdf(d);
      } catch (pdfError) {
        console.error('PDF生成エラー:', pdfError.message);
      }

      try {
        await writeToSheet(d, pdfLink);
      } catch (sheetError) {
        console.error('スプレッドシート書き込みエラー:', sheetError.message);
      }

      sendNotificationMail(d).catch((mailError) => {
        console.error('通知メール送信エラー:', mailError.message);
      });
      sendConfirmationMail(d).catch((mailError) => {
        console.error('受付完了メール送信エラー:', mailError.message);
      });
    })();

    res.json({ ok: true });
  } catch (error) {
    console.error('Submit error:', error);
    res.status(500).json({ ok: false, error: error.message || '送信処理に失敗しました。' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3010;
app.listen(PORT, () => {
  console.log(`臨時出店届フォーム running at http://localhost:${PORT}`);
});
