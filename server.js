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
  grill: '食材を焼く', boil: '食材と水を鍋で煮る', steam: '食材を蒸し器で蒸す', fry: '食材を油で揚げる',
  tea_bag: '市販のティーバッグで一杯ずつ抽出する',
  coffee_dripper: '使い捨てドリッパーで一杯ずつ抽出する',
};
// 単杯抽出であることが選択肢自体から確定している調理方法（自由記述での追加確認は不要）
const SINGLE_SERVE_COOKING_METHODS = ['tea_bag', 'coffee_dripper'];
const STORAGE_LABELS = { normal: '常温', cold: '冷蔵（クーラーBOX等）', frozen: '冷凍' };
const SERVE_METHOD_LABELS = { disposable: '使い捨て容器にて提供', cup: '使い捨てカップにて提供' };

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// 国内仕入れ先チェック用（簡易・完全ではない）
const OVERSEAS_KEYWORDS = ['中国', 'アメリカ', 'USA', '韓国', '台湾', 'ベトナム', 'タイ', 'インド', 'フランス', 'イタリア', '海外'];
// 使用不可の材料キーワード
const BANNED_INGREDIENT_KEYWORDS = ['牛乳', '生乳'];
// ご飯類をその場でよそう提供は不可（保健所確認済み）。パック詰め販売かクスクス等への変更が必要
const RICE_KEYWORDS = ['ご飯', '白米', 'ライス', 'おにぎり', 'カレーライス'];
// 「米」は部分一致だと「米粉」「米油」等の無関係な加工品まで拾ってしまうため、
// フィールドの中身がちょうど「米」「お米」「生米」の場合だけヒットさせる
const PLAIN_RICE_KEYWORDS = ['米', 'お米', '生米'];
function detectPlainRiceWording(texts) {
  const list = Array.isArray(texts) ? texts : [texts];
  return list.some((t) => t && PLAIN_RICE_KEYWORDS.includes(t.trim()));
}
// 曖昧な調理表現
const VAGUE_COOKING_PHRASES = ['熱湯を注ぐ'];
// 「温める」「あたためる」は言葉自体が使用不可（保健所確認済み：滅菌できる強い加熱の言葉が必要）
// 語幹＋活用語尾の組み合わせでマッチさせる（語幹だけだと「常温めんつゆ」のような無関係な語に誤爆するため）
const WEAK_HEAT_REGEX = /(温め|あたため)(る|て|た|ます|ない)/;
// 「茹でる」（大量の水を使う調理）は不可、「煮る」を選ぶよう案内する
const BOIL_WORD_REGEX = /茹で(る|て|た|ます|ない)/;
// 自家調合ドリンク（清涼飲料水製造業の許可が必要になるパターン）
const SELF_MADE_DRINK_KEYWORDS = ['シロップ', 'コーディアル', '自家製ドリンク', '自家調合', '自家製シロップ', '果汁'];
// 上記キーワードと同一フィールド内にこれが含まれていれば「市販品を使う」宣言と見なし、許可施設の記載は不要にする
const MARKET_BOUGHT_MARKER = '市販';
// 生の柑橘をそのままドリンクに使うのは不可（保健所確認済み：市販シロップに置き換える必要がある）
const RAW_CITRUS_DRINK_KEYWORDS = ['レモン', 'ライム', 'かぼす', 'すだち'];
// 生のまま提供されやすい／加熱が前提の食材（保健所確認済み：生のまま提供は不可）。
// 野菜・麺・肉・魚介・卵などカテゴリごとに文言を出し分けると、AIチェック側でカテゴリの
// 誤判定が起きる（実測で発生済み）ため、カテゴリを問わず同じ汎用文言で統一して扱う
const RAW_VEGETABLE_KEYWORDS = ['きゅうり', 'レタス', 'トマト', 'キャベツ', '水菜', 'パクチー', 'もやし', '生野菜', '生の野菜', '生の果物'];
const RAW_OTHER_KEYWORDS = ['焼きそば', 'そば', 'うどん', 'ラーメン', 'パスタ', '麺', '豚肉', '鶏肉', '牛肉', 'ひき肉', '魚', 'エビ', 'イカ', 'タコ', '卵'];
const RAW_OR_HEAT_NEEDED_KEYWORDS = [...RAW_VEGETABLE_KEYWORDS, ...RAW_OTHER_KEYWORDS];
function rawFoodMessage() {
  return '生の食材は保健所の許可が通らない場合があります。調理方法で「その他」を選び、加熱する内容を明記してください。';
}
// 実際に加熱する調理方法（これ以外は「加熱した」と見なさない）
const HEAT_COOKING_METHODS = ['grill', 'boil', 'steam', 'fry'];
// 常温保存でも問題ない食品（これに該当しなければ常温は警告対象）
const DRY_SAFE_KEYWORDS = ['乾麺', '乾き物', '乾物', 'せんべい', 'クッキー', 'ビスケット', '飴', 'キャンディ', 'ポップコーン', 'スナック', 'ドライフルーツ', '焼き菓子', '駄菓子', 'チップス', 'ナッツ', 'コーヒー粉', 'ドリップパック', '茶葉', 'お茶の葉', '紅茶葉', 'ティーバッグ'];
// ハム・チーズは許可が通らない（保健所確認済み）
const HAM_CHEESE_KEYWORDS = ['ハム', 'チーズ'];
// コーヒー・紅茶等、まとめて作り置きせず一杯ずつ抽出する必要があるドリンク（保健所確認済み）
// 「お茶」は「お茶漬け」等に部分一致してしまうため含めない。紅茶と珈琲で案内文言を分けるため別リストで持つ
const TEA_KEYWORDS = ['紅茶'];
const COFFEE_KEYWORDS = ['コーヒー', '珈琲'];
const SINGLE_SERVE_BAG_KEYWORDS = ['ティーバッグ', 'ドリップバッグ'];
// コーヒー抽出は「使い捨てドリッパー」か「市販のカセット式ドリッパー」のどちらかが必要（保健所確認済み）
const COFFEE_DRIPPER_KEYWORDS = ['使い捨てドリッパー', '市販のカセット式ドリッパー'];
// クレープは現地で焼く必要がある（保健所確認済み：前日仕込み・温め提供は不可）
const CREPE_KEYWORD = 'クレープ';

function isBlank(v) {
  return v === undefined || v === null || String(v).trim() === '';
}

function containsAny(text, keywords) {
  if (!text) return null;
  const hit = keywords.find((k) => text.includes(k));
  return hit || null;
}

function detectWeakHeatWord(text) {
  if (!text) return null;
  const m = text.match(WEAK_HEAT_REGEX);
  return m ? m[0] : null;
}

function detectBoilWord(text) {
  if (!text) return null;
  const m = text.match(BOIL_WORD_REGEX);
  return m ? m[0] : null;
}

// 柑橘の記載のうち「生のまま使う」ものだけを検知する（シロップ・果汁のような加工表記があれば対象外）。
// シロップとしての自家製／市販の扱いは、柑橘に限らず全てdrinkPermitFacilityの統一ルールで扱う。
//
// 検知対象（triggerTexts）と、処理済みの証拠として認める対象（exemptTexts）を分けている。
// 「レモンスカッシュ」のように食品名自体に果物名が入っている場合、材料欄で「市販のレモンシロップ」
// と明記されていても、食品名だけを見ると「シロップ」の語が付かず誤って生食扱いされる問題があった。
// これを直すため、食品名・材料欄（短い名詞句で、通常は言い切りの記載）はexemptTextsとして
// 結合し、証拠が同じ提出物のどこにあっても拾えるようにした。
// 一方、その他調理方法欄・仕込み内容欄は自由記述の文章で「レモンシロップは使わず生搾りする」の
// ような否定文を含みうるため、この2つはtriggerTextsには含めるが、exemptTextsには含めない
// （否定文中の「レモンシロップ」という部分文字列だけで処理済みと誤認しないようにするため）
function detectCitrusIssues(exemptTexts, extraTriggerTexts) {
  const exemptList = Array.isArray(exemptTexts) ? exemptTexts : [exemptTexts];
  const exemptJoined = exemptList.filter(Boolean).join(' ');
  const triggerJoined = [exemptJoined, ...(Array.isArray(extraTriggerTexts) ? extraTriggerTexts : [extraTriggerTexts])].filter(Boolean).join(' ');
  const results = [];
  for (const k of RAW_CITRUS_DRINK_KEYWORDS) {
    if (!triggerJoined.includes(k)) continue;
    const isProcessed = exemptJoined.includes(`${k}シロップ`) || exemptJoined.includes(`${k}果汁`);
    if (isProcessed) continue;
    results.push({ type: 'raw', fruit: k });
  }
  return results;
}

// シロップ・果汁等のドリンクは清涼飲料水製造業の許可施設の記載が必要（保健所確認済み）。
// 「市販」と同じ区切りの記載単位に書かれていれば市販品の宣言と見なし、その分は施設記載不要とする。
// フィールド全体での共起にすると「自家製シロップ、市販のレモン果汁」のように1欄に複数品目を
// 書いた場合に無関係な「市販」で自家製側まで打ち消してしまうため、品目の区切りとして使われがちな
// 読点・カンマ・中黒・空白で区切って判定する
// texts は個別のフィールドごとの配列で渡すこと
function detectDrinkPermitNeeded(texts) {
  const list = Array.isArray(texts) ? texts : [texts];
  for (const text of list) {
    if (!text) continue;
    for (const segment of text.split(/[、,・\s]+/)) {
      const hit = containsAny(segment, SELF_MADE_DRINK_KEYWORDS);
      if (hit && !segment.includes(MARKET_BOUGHT_MARKER)) {
        return hit;
      }
    }
  }
  return null;
}

// コーヒー・紅茶等をまとめて作り置きするのは不可（保健所確認済み）
// 市販のティーバッグ・ドリップバッグで一杯ずつ抽出する形への変更が必要。
// 紅茶か珈琲かで返り値を分け、案内文言を出し分ける（現状は紅茶側のみ具体化。珈琲は今後検討）
// 先に紅茶か珈琲かを確定してから「一杯ずつ抽出」の証拠を判定する（コーヒー用のドリッパー語彙が
// 紅茶側の判定まで打ち消してしまわないようにするため。逆に紅茶用のティーバッグ語彙はコーヒーにも
// 使えるので珈琲側の証拠としても引き続き有効にする）
function detectBulkBrewedDrink(d) {
  const text = [d.foodName, ...(d.ingredients || []), d.cookingMethodOther].filter(Boolean).join(' ');
  // 固定選択肢「市販のティーバッグ／使い捨てドリッパーで一杯ずつ抽出する」は
  // 選択自体が単杯抽出の確認になるため、自由記述欄（cookingMethodOther）で
  // 使い捨てバッグ／ドリッパーの言葉を別途探す必要はない。
  // 自由記述欄がある「その他」を選んだ場合のみ、その中身で単杯抽出を確認する
  if (SINGLE_SERVE_COOKING_METHODS.includes(d.cookingMethod)) return null;
  const brewingMethod = d.cookingMethod === 'other';
  if (!brewingMethod) return null;
  const isTea = Boolean(containsAny(text, TEA_KEYWORDS));
  const isCoffee = Boolean(containsAny(text, COFFEE_KEYWORDS));
  if (!isTea && !isCoffee) return null;
  const hasSingleServeBag = Boolean(containsAny(text, SINGLE_SERVE_BAG_KEYWORDS));
  const hasCoffeeDripper = isCoffee && Boolean(containsAny(text, COFFEE_DRIPPER_KEYWORDS));
  if (hasSingleServeBag || hasCoffeeDripper) return null;
  return isTea ? 'tea' : 'coffee';
}

// 材料欄に何を書くべきか・調理方法で何を選ぶべきかまで具体的に示す（紅茶）。珈琲は暫定で汎用文言のまま
function bulkBrewedDrinkMessage(type) {
  if (type === 'tea') {
    return '茶葉の使用は許可がおりません。許可をもらうため、食材には「市販のティーバッグ」と記載して、調理方法は「市販のティーバッグで一杯ずつ抽出する」を選択してください。';
  }
  return 'まとめて作り置きは許可がおりません。許可をもらうため、調理方法で「使い捨てドリッパーで一杯ずつ抽出する」を選択してください。';
}

// コーヒー関連ルールは全て「取扱食品名にコーヒー/珈琲/coffeeが含まれる」場合のみ適用する
function isCoffeeFoodName(foodName) {
  if (!foodName) return false;
  if (foodName.includes('コーヒー') || foodName.includes('珈琲')) return true;
  return /coffee/i.test(foodName);
}

// コーヒー豆をその場で挽く（粉にする）のは不可（保健所確認済み）
// 「事前に挽いてある」のような、既に挽いてある豆の状態を説明する言い方は誤検知しないよう
// PRE_GROUND_KEYWORDSで明示的に除外する（活用形を正規表現で網羅するより誤りが少ないため）
// キーワード方式なので完璧ではない（想定外の言い回しは拾いきれない）。
// AIチェック側はこの判断を一切行わない設計にしたため（材料欄が「コーヒー粉」・仕込み内容欄が
// 「焙煎する」等の組み合わせを食い違いとして理屈っぽく指摘してしまう問題があった）、
// foodName・ingredients・cookingMethodOther・prepDetailの4箇所全てを、呼び出し側で
// 組み合わせて渡すこと（1箇所でも渡し忘れると、その欄経由の「その場で挽く」記載が
// 機械チェック・AIチェックどちらでも検知されず素通りしてしまう）
// texts は呼び出し側でfoodName・ingredients等と組み合わせた配列で渡すこと（コーヒーの言及と挽く語が
// 同じ提出物のどこにあっても拾えるように、単一欄だけでなく複数欄をまとめて渡す）
const GRIND_KEYWORDS = ['挽く', '挽いて', '挽き', '挽いた', '粉にする', '粉にして', '粉にした'];
const PRE_GROUND_KEYWORDS = ['事前に', 'あらかじめ', '挽いてある', '粉にしてある', '挽いたもの', '挽き済み', '仕入れ'];
function detectGroundOnSiteCoffee(texts) {
  const text = [].concat(texts).filter(Boolean).join(' ');
  const isCoffee = text.includes('コーヒー') || text.includes('珈琲');
  if (!isCoffee) return false;
  if (!containsAny(text, GRIND_KEYWORDS)) return false;
  if (containsAny(text, PRE_GROUND_KEYWORDS)) return false;
  return true;
}

// 材料欄に「豆」とだけ書く、または「珈琲豆」「コーヒー豆」と書くと通らない（保健所確認済み。
// 「コーヒー粉」「ドリップパック」への変更が必要）。「豆乳」「黒豆」等の無関係な語への誤爆を避けるため、
// 材料欄の中身がちょうど「豆」だけの場合か、上記の複合語を含む場合だけヒットさせる（部分一致の「豆」1文字では判定しない）
function detectCoffeeBeanWording(ingredients) {
  const list = Array.isArray(ingredients) ? ingredients : [ingredients];
  return list.some((ing) => {
    if (!ing) return false;
    const trimmed = ing.trim();
    return trimmed === '豆' || trimmed.includes('珈琲豆') || trimmed.includes('コーヒー豆');
  });
}

// 材料欄が「コーヒー粉」の提出（材料欄の豆表記は上のdetectCoffeeBeanWordingで既に機械ブロック済みなので、
// ここに到達する時点で材料欄は豆表記ではない）でも、仕込み内容欄・その他調理方法欄に「豆を焙煎する」等の
// 記載があると、AIチェックが繰り返し「豆なのか粉なのか整合していない」と誤指摘してしまう問題があった。
// プロンプトでの指示（最重要ルール２）だけでは実測で抑制しきれなかったため、AIに渡す前に該当する語自体を
// 中立的な語に置き換え、AI側に比較対象となる文言そのものを見せないことで確実に止める。
// 単純に削除すると「コーヒー豆をローストする」が「をする」のような壊れた文になり、
// 今度は「内容が不明」という別の誤指摘を誘発するため、文として成立する語に置き換える
// 「豆乳」は無関係な食材として頻出するため、「豆」の単独置換からは除外する（先に固定の複合語を
// 潰してから、最後に残った単独の「豆」を置換する順序にすること）
const COFFEE_BEAN_PROCESS_REPLACEMENTS = [
  [/コーヒー豆/g, 'コーヒー'],
  [/珈琲豆/g, '珈琲'],
  [/生豆/g, 'コーヒー'],
  [/焙煎/g, '準備'],
  [/ロースト/g, '準備'],
  [/豆(?!乳)/g, 'コーヒー'],
];
function stripCoffeeBeanProcessWording(text) {
  if (!text) return text;
  return COFFEE_BEAN_PROCESS_REPLACEMENTS.reduce((acc, [re, rep]) => acc.replace(re, rep), text);
}

// コーヒーのドリッパーは「使い捨て」か「カセット式」（市販の使い捨てカセット付き）以外は使用不可
// （保健所確認済み。使い捨てドリッパーは目黒マルシェで30円販売）
function detectNonDisposableDripper(texts) {
  const joined = [].concat(texts).filter(Boolean).join(' ');
  return joined.includes('ドリッパー') && !joined.includes('使い捨て') && !joined.includes('カセット式');
}

// ハム・チーズ、「具材」の曖昧記載、ホイップクリームの植物性明記漏れをチェック
// ハム・チーズ両方書かれているケースを取りこぼさないよう、該当する全キーワードを返す
function detectHamCheese(texts) {
  const joined = [].concat(texts).filter(Boolean).join(' ');
  return HAM_CHEESE_KEYWORDS.filter((k) => joined.includes(k));
}
function detectVagueFillingWord(texts) {
  return [].concat(texts).filter(Boolean).join(' ').includes('具材');
}
function detectNonPlantWhipCream(texts) {
  const joined = [].concat(texts).filter(Boolean).join(' ');
  const hasCream = joined.includes('ホイップクリーム') || joined.includes('生クリーム');
  return hasCream && !joined.includes('植物性');
}

// 「温める」等の弱い加熱表現は不可。クレープの文脈であれば専用メッセージを返す
function weakHeatWordMessage(hasCrepe) {
  if (hasCrepe) {
    return 'クレープは許可が取りにくいです。「現地でクレープを焼き具材を挟む」と余計なことは書かずシンプルに記入してください。';
  }
  return '「温める」という言葉は使えません。加熱、煮る、焼く、蒸すなどの強く火が通る滅菌できる言葉を使ってください。';
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
  } else if (Number(d.cumulativeDays) < 1 || Number(d.cumulativeDays) > 5) {
    errors.cumulativeDays = '目黒区の出店は５日までなのでその範囲で記載お願いします。';
  }

  if (d.businessType !== 'restaurant' && d.businessType !== 'retail') {
    errors.businessType = '「飲食店（その場で調理して提供）」か「食品物販（完成品を販売するのみ）」のどちらか一方を選んでください。';
  }

  if (d.businessType === 'restaurant') {
    if (isBlank(d.foodName)) {
      errors.foodName = '取扱食品名を入力してください。';
    } else if (looksLikeMultipleItems(d.foodName)) {
      errors.foodName = '取扱食品名は1品のみ記載してください。複数書くと許可が通りません。';
    } else {
      const hamCheeseInName = detectHamCheese(d.foodName);
      if (hamCheeseInName.length > 0) {
        errors.foodName = `食品名に「${hamCheeseInName.join('」「')}」は使用できません。名称を変更してください。`;
      }
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
      // 材料欄に関する指摘は、最初に見つかった1件だけでなく該当する分をすべて集めて表示する
      const issues = [];

      const bannedHits = new Set();
      for (const ing of ingredients) {
        const banned = containsAny(ing, BANNED_INGREDIENT_KEYWORDS);
        if (banned) bannedHits.add(banned);
      }
      bannedHits.forEach((b) => issues.push(`「${b}」は臨時出店では使用できません。オーツミルク・豆乳など代替品に変更してください。`));

      // ご飯類をその場でよそう提供は不可
      if (containsAny([d.foodName, ...ingredients, d.cookingMethodOther].filter(Boolean).join(' '), RICE_KEYWORDS) || detectPlainRiceWording([d.foodName, ...ingredients, d.cookingMethodOther])) {
        issues.push('ご飯をその場でよそるのは許可が下りません。パック詰めしたものを販売か、クスクスなどに変更して下さい。');
      }

      // ハム/チーズ・ホイップクリーム・ドリッパー・「具材」曖昧表現は、材料欄自体に書かれている分だけをここで拾う。
      // その他調理方法欄・仕込み内容欄に書かれた分は、それぞれの欄側で個別に拾って
      // 該当する欄（errors.cookingMethodOther／errors.prepDetail）に表示する（材料欄に誤って表示されないように）。
      if (detectHamCheese(ingredients).length > 0) {
        issues.push('「ハム」「チーズ」を記載すると通らないことが多いです。許可をもらうため、他の食材を記入してください。');
      }
      if (detectNonPlantWhipCream(ingredients)) {
        issues.push('ホイップクリームは許可をもらうため、「植物性ホイップクリーム」と記入してください。');
      }
      if (detectNonDisposableDripper(ingredients)) {
        issues.push('ドリッパーは「使い捨て」か「市販のカセット式」以外は使用できません。（使い捨てドリッパーは30円で目黒マルシェで販売しています）。');
      }
      if (detectVagueFillingWord(ingredients)) {
        issues.push('「具材」だけだと許可が通らないことが多いため、具体的な食材を2つほど記載してください。');
      }

      // コーヒーの材料欄に「豆」とだけ書く、または「珈琲豆」「コーヒー豆」と書くと通らない
      if (isCoffeeFoodName(d.foodName) && detectCoffeeBeanWording(ingredients)) {
        issues.push('コーヒー豆は許可が通らない可能性があるので、コーヒー粉と記載してください。');
      }

      // 生の柑橘（レモン等）をそのまま使う記載は許可が通らない（複数あれば全部）。
      // シロップとしての自家製／市販の扱いは drinkPermitFacility の統一ルールで別途判定する
      // 検知対象はその他調理方法欄・仕込み内容欄まで含めるが、他のチェックと違いエラーは
      // 常にingredients欄に表示する（柑橘チェックは項目ごとに分けていない）
      const citrusIssues = detectCitrusIssues([d.foodName, ...ingredients], [d.cookingMethodOther, d.prepDetail]);
      citrusIssues.forEach((ci) => {
        issues.push(`「${ci.fruit}」は許可が通らないことが多いので、別のものを記載お願いします。`);
      });

      if (issues.length > 0) {
        errors.ingredients = issues.join('\n');
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
      } else if (detectVagueFillingWord(d.prepDetail)) {
        errors.prepDetail = '「具材」だけだと許可が通らないことが多いため、具体的な食材を2つほど記載してください。';
      } else if (detectHamCheese(d.prepDetail).length > 0) {
        errors.prepDetail = '「ハム」「チーズ」を記載すると通らないことが多いです。許可をもらうため、他の食材を記入してください。';
      } else if (detectNonPlantWhipCream(d.prepDetail)) {
        errors.prepDetail = 'ホイップクリームは許可をもらうため、「植物性ホイップクリーム」と記入してください。';
      } else if (detectNonDisposableDripper(d.prepDetail)) {
        errors.prepDetail = 'ドリッパーは「使い捨て」か「市販のカセット式」以外は使用できません。（使い捨てドリッパーは30円で目黒マルシェで販売しています）。';
      } else if (detectGroundOnSiteCoffee([d.foodName, ...(d.ingredients || []), d.prepDetail])) {
        errors.prepDetail = '豆をその場で粉にすることを記載すると通りません。';
      } else {
        // 茹でる禁止は現場（出店ブース）の設備制約が理由なので、許可施設で行う仕込みには適用しない
        const weakHeat = detectWeakHeatWord(d.prepDetail);
        if (weakHeat) {
          const hasCrepe = [d.foodName, ...(d.ingredients || []), d.prepDetail].filter(Boolean).join(' ').includes(CREPE_KEYWORD);
          errors.prepDetail = weakHeatWordMessage(hasCrepe);
        }
      }
    }

    if (!d.cookingMethod) {
      errors.cookingMethod = '調理方法を1つ選んでください（2種類以上は選べません）。';
    } else if (d.cookingMethod === 'other') {
      if (isBlank(d.cookingMethodOther)) {
        errors.cookingMethodOther = '「その他」を選んだ場合は具体的な調理方法を入力してください。';
      } else if (detectBoilWord(d.cookingMethodOther)) {
        errors.cookingMethodOther = '茹でる（大量の水を使う調理）は許可が通りません。「煮る」を選択してください。';
      } else if (detectVagueFillingWord(d.cookingMethodOther)) {
        errors.cookingMethodOther = '「具材」だけだと許可が通らないことが多いため、具体的な食材を2つほど記載してください。';
      } else if (detectHamCheese(d.cookingMethodOther).length > 0) {
        errors.cookingMethodOther = '「ハム」「チーズ」を記載すると通らないことが多いです。許可をもらうため、他の食材を記入してください。';
      } else if (detectNonPlantWhipCream(d.cookingMethodOther)) {
        errors.cookingMethodOther = 'ホイップクリームは許可をもらうため、「植物性ホイップクリーム」と記入してください。';
      } else if (detectNonDisposableDripper(d.cookingMethodOther)) {
        errors.cookingMethodOther = 'ドリッパーは「使い捨て」か「市販のカセット式」以外は使用できません。（使い捨てドリッパーは30円で目黒マルシェで販売しています）。';
      } else if (detectWeakHeatWord(d.cookingMethodOther)) {
        // 「温める」系の言葉は曖昧チェックにも該当するが、こちらの方が具体的なので優先する
        const hasCrepe = [d.foodName, ...(d.ingredients || []), d.cookingMethodOther].filter(Boolean).join(' ').includes(CREPE_KEYWORD);
        errors.cookingMethodOther = weakHeatWordMessage(hasCrepe);
      } else if (detectGroundOnSiteCoffee([d.foodName, ...(d.ingredients || []), d.cookingMethodOther])) {
        errors.cookingMethodOther = '豆をその場で粉にすることを記載すると通りません。';
      } else if (detectBulkBrewedDrink(d)) {
        // 豆から挽いて熱湯を注ぐ系の短い記述は曖昧チェックにも該当するため、より具体的なこちらを優先する
        errors.cookingMethodOther = bulkBrewedDrinkMessage(detectBulkBrewedDrink(d));
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
    // 単杯抽出専用の固定選択肢（SINGLE_SERVE_COOKING_METHODS）は、都度その場で抽出するティーバッグ・
    // コーヒー粉自体の保存を指しており、これらは元々乾燥した常温保存可能な材料のため、常温警告の対象外とする
    if (d.storage === 'normal' && !errors.foodName && !SINGLE_SERVE_COOKING_METHODS.includes(d.cookingMethod)) {
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

    // シロップ等を炭酸水・水で割るドリンクは、購入品でも自家製造でも清涼飲料水製造業の許可施設の記入が必要
    // （材料欄の指摘で既にエラー確定していれば errors.ingredients が立っているのでここは自然にスキップされる）
    if (!errors.ingredients && !errors.cookingMethodOther) {
      const drinkHit = detectDrinkPermitNeeded([d.foodName, ...(d.ingredients || []), d.cookingMethodOther]);
      if (drinkHit) {
        if (isBlank(d.drinkPermitFacilityName) || isBlank(d.drinkPermitFacilityAddress)) {
          errors.drinkPermitFacility = '自家製シロップは通らないことが多いです。清涼飲料水製造許可のある施設でない場合、許可をもらうため、「市販のシロップを使用」と記載お願いします。施設をお持ちの場合は施設の名称と住所を記入してください。';
        }
      }
    }

    // コーヒー豆をその場で挽くのは不可（テキスト内容のみで判定するため調理方法の選択肢は問わない）
    if (!errors.ingredients && !errors.cookingMethodOther && detectGroundOnSiteCoffee([d.foodName, ...(d.ingredients || []), d.cookingMethodOther])) {
      errors.ingredients = '豆をその場で粉にすることを記載すると通りません。';
    }

    // コーヒー・紅茶等をまとめて作り置きするのは許可が通らない（cookingMethod='other'で自由記述がある場合のみ判定。
    // 単杯抽出専用の固定選択肢（SINGLE_SERVE_COOKING_METHODS）は選択自体が確認になるためdetectBulkBrewedDrink内で対象外）
    if (!errors.ingredients && !errors.cookingMethodOther && detectBulkBrewedDrink(d)) {
      errors.ingredients = bulkBrewedDrinkMessage(detectBulkBrewedDrink(d));
    }

    // 生のまま提供されやすい／加熱が前提の食材なのに、実際に加熱する調理方法が選ばれていない。
    // 「その他」は、具体的な調理方法欄に何か書かれていて、かつ「温める」系の曖昧な言葉でなければ
    // 加熱調理とみなす（「焼く」「炒める」等の言葉を1つずつ列挙する方式だと、単語が抜けるたびに
    // 正しく加熱を書いても弾かれる不具合が起きるため、単語の完全一致は要求しない。
    // 「温める」だけは detectWeakHeatWord で別途、常に禁止する）
    if (!errors.ingredients && !errors.cookingMethod) {
      const rawText = [d.foodName, ...(d.ingredients || [])].filter(Boolean).join(' ');
      const rawHit = containsAny(rawText, RAW_OR_HEAT_NEEDED_KEYWORDS);
      const isHeated = HEAT_COOKING_METHODS.includes(d.cookingMethod)
        || (d.cookingMethod === 'other' && !isBlank(d.cookingMethodOther) && !detectWeakHeatWord(d.cookingMethodOther));
      if (rawHit && !isHeated) {
        errors.cookingMethod = rawFoodMessage();
      }
    }
  }

  if (d.businessType === 'retail') {
    if (isBlank(d.foodName)) {
      errors.foodName_r = '取扱食品名を入力してください。';
    } else if (looksLikeMultipleItems(d.foodName)) {
      errors.foodName_r = '取扱食品名は1品のみ記載してください。複数書くと許可が通りません。';
    }
    if (isBlank(d.servingCount)) {
      errors.servingCount_r = '提供数を入力してください。';
    } else if (!/^[0-9]+$/.test(String(d.servingCount).trim())) {
      errors.servingCount_r = '提供数は数字で入力してください。';
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

    if (!d.storage) errors.storage_r = '保存方法を選んでください。';
    if (d.storage === 'other' && isBlank(d.storageOther)) {
      errors.storageOther_r = '保存方法の「その他」の内容を入力してください。';
    }
  }

  return errors;
}

// フォーム内部のコード値（例：cookingMethod="boil"）をそのままAIに渡すと、
// 英単語の意味（boil=茹でる）につられて誤判定することがある（実際に「boil」を
// 「食材と水を鍋で煮る」の意味で使っているのに「茹でる」と誤解された事例あり）。
// PDF表示と同じ日本語ラベルに変換してからAIに渡すことで、この種の誤判定を防ぐ
// 「その他」（コード値"other"）はラベル対応表に存在しないため、PDF生成と同じく
// 自由記述欄の中身にフォールバックする（それも空ならコード値のまま残す）
// AIに渡すJSONのキー名（英語のプログラム変数名）自体をここで日本語に変換する。
// 値だけ日本語化してキー名を英語のまま残すと、AIが入力に見えている英語のキー名を
// そのまま指摘文にコピーしてしまう事例が実際にあったため（drinkPermitFacilityName等）、
// キー名も含めて英語がAIの目に触れないようにする
const FIELD_LABELS = {
  address: '出店者の住所', shopName: '店名', personName: '担当者の個人名', phone: '電話番号',
  email: 'メールアドレス', cumulativeDays: '本年度の累計出店日数', businessType: '業態区分',
  foodName: '取扱食品名', servingCount: '提供数', ingredients: '使う食材',
  ingredientSourceType: '材料の仕入れ区分', ingredientSourceName: '材料の購入先（名前）', ingredientSourceAddress: '材料の購入先（住所）',
  drinkPermitFacilityName: '清涼飲料水の許可施設（名称）', drinkPermitFacilityAddress: '清涼飲料水の許可施設（住所）',
  prep: '仕込みについて', prepFacilityName: '仕込みを行う施設（名称）', prepFacilityAddress: '仕込みを行う施設（住所）', prepDetail: '当日仕込み内容',
  cookingMethod: '調理方法', cookingMethodOther: '具体的な調理方法',
  storage: '保存方法', storageOther: '保存方法の内容',
  serveMethod: '提供方法', serveMethodOther: 'その他の提供方法',
  supplierName: '仕入先の名前', selfMade: '仕入れ先', facilityName: '施設名', facilityAddress: '施設住所', supplierAddress: '仕入先の住所',
  packagingConfirmed: '包装済み完成品を販売する', isFrozen: '冷凍食品を扱う', frozenLabelConfirmed: '冷凍食品である旨の表示がある',
};

function humanizeSubmission(d) {
  const h = { ...d };
  if (d.cookingMethod) h.cookingMethod = COOKING_METHOD_LABELS[d.cookingMethod] || (d.cookingMethod === 'other' ? 'その他（具体的な調理方法欄を参照）' : d.cookingMethod);
  if (d.storage) h.storage = STORAGE_LABELS[d.storage] || (d.storage === 'other' ? 'その他（保存方法の内容欄を参照）' : d.storage);
  if (Array.isArray(d.serveMethod)) h.serveMethod = d.serveMethod.map((m) => SERVE_METHOD_LABELS[m] || (m === 'other' ? 'その他（その他の提供方法欄を参照）' : m));
  if (d.businessType) h.businessType = d.businessType === 'restaurant' ? '飲食店' : d.businessType === 'retail' ? '食品物販' : d.businessType;
  if (d.ingredientSourceType) {
    h.ingredientSourceType = d.ingredientSourceType === 'selfmade'
      ? '保健所許可のある場所で自家製造する'
      : d.ingredientSourceType === 'purchase' ? '購入する' : d.ingredientSourceType;
  }
  if (d.prep) h.prep = d.prep === 'onsite' ? '保健所許可のある施設（またはシェアキッチン等）で当日仕込みあり' : d.prep === 'none' ? '仕込みなし' : d.prep;
  if (d.selfMade) h.selfMade = d.selfMade === 'yes' ? '保健所許可のある場所で自家製造したものを販売する' : d.selfMade === 'no' ? '購入する' : d.selfMade;

  // キー名を日本語ラベルに付け替える（対応表にないキーは念のため英語のまま残す）
  const relabeled = {};
  for (const [key, value] of Object.entries(h)) {
    relabeled[FIELD_LABELS[key] || key] = value;
  }
  return relabeled;
}

// ===== AI意味チェック（構造では防げない食品衛生の妥当性判断） =====
// 「同上」不要ルールと「加熱する等を温めるとみなさない」ルールは、実際の主催者が
// 本番直前の最終テストで遭遇した誤指摘（仕込み先住所の「同上」記載を誤読、
// フォーム自身が推奨する「加熱する」を温めると同一視）を踏まえて追加したもの。
// 削除するとこれらの誤指摘が再発するので、消す場合は理由を確認してから。
//
// 「生食材の加熱有無を判断しない」という最重要ルールは、バグで抜けているのではなく意図的。
// 元々は生食材（野菜・肉・魚介等）が実際に加熱されているかをAIに判断させていたが、
// 主催者が「その他」を選んで加熱内容を明記していても誤って指摘する等、緩めても厳しくしても
// 誤判定が消えなかったため（機械チェック＝validateSubmission内のrawFoodMessage関連は
// 決まった調理方法を選んだ場合に生食材を機械的に検出でき、こちらは維持している）、
// 主催者の判断でAI側の生食材判定機能そのものを廃止した。復活させる場合は要相談。
async function aiSemanticCheck(d) {
  const systemPrompt = `あなたは目黒マルシェの「臨時出店届」の内容を確認する担当者です。

最重要ルール（他のどの指示より優先します）：材料や調理方法・仕込み内容に書かれた食材（野菜・肉・魚介・麺・卵など、種類を問わず全て）について、それが十分に加熱されているか、生のまま提供される可能性がないか、実態が不明確ではないか、を判断・指摘することは、あなたの担当ではありません。この判断は別の仕組みが既に行っています。
- 加熱が不十分に見えても、生のまま提供されそうに見えても、記載が曖昧に見えても、絶対に指摘しないでください。
- 「実際に焼くのか生のまま使うのか不明確」「加熱の記載を確認してください」「生の状態で提供される場合は」のような、加熱・生食の状態そのものに触れる指摘は、表現を変えても一切禁止です。
- この最重要ルールは、下記の他のどの指摘例よりも優先します。判断に迷ったら、加熱・生食に触れない方を選んでください。

最重要ルール２（他のどの指示より優先します）：コーヒー豆・コーヒー粉に関する記載（材料欄が「豆」か「粉」か、仕込み内容欄や調理方法欄に焙煎・挽くといった言葉があるか）について、一切判断・指摘しないでください。この判断は別の仕組みが既に行っています。

入力されたJSONの内容を見て、食品衛生上の危険や、記載内容が明らかに矛盾していて保健所で確認が必要になる点だけを指摘してください（ただし上記の最重要ルール・最重要ルール２の範囲は除く）。
文章の言い回し・表現の重複・言葉の選び方など、食品衛生に関係ない文章表現上の指摘はしないでください（同じ言葉が2回出てくる、もっと丁寧な言い方がある、等は指摘対象外）。
以下はすでに機械的にチェック済みなので、指摘不要です:
- 必須項目の空欄
- 業態区分の二重選択
- 禁止材料（牛乳）の使用
- ご飯類（ご飯・白米・ライス・おにぎり・カレーライス）をその場でよそう提供の指摘
- 現場の調理方法・その他調理方法欄での「茹でる」（大量の水を使う調理）の指摘（仕込み内容欄は許可施設で行う前提のため対象外。仕込み内容欄に「茹でる」とあっても指摘不要）
- 購入先の空欄・海外住所
- シロップ・果汁・コーディアル系ドリンク（柑橘の自家製シロップ含む）の清涼飲料水製造業許可の指摘（清涼飲料水の許可施設の名称・住所の欄に記入がある、または材料欄等に「市販」と明記されていれば、許可施設の記載要件は既に満たされているので指摘不要）
- 生のレモン・ライム等をドリンクにそのまま使う点の指摘
- コーヒー・紅茶等をまとめて作り置きする点の指摘（市販ティーバッグ・ドリップバッグへの変更）
- コーヒーのドリッパーが「使い捨て」でも「カセット式」でもない点の指摘
- コーヒーの材料欄に「豆」とだけ、または「珈琲豆」「コーヒー豆」と書かれている点の指摘（「コーヒー粉」「ドリップパック」への変更）
- 「温める」「あたためる」という言葉自体が使用不可な点の指摘
- 「具材」という曖昧な記載の指摘
- ホイップクリームの植物性明記漏れの指摘
- クレープの現地調理（前日仕込み・温め提供は不可）の指摘
- 仕込み先・自家製造施設・清涼飲料水製造許可施設など、施設の名称・住所を尋ねるどの欄であっても「同上」と記載されている点の指摘（出店者自身の住所・店名が、既に許可を得た施設であることを示す一般的な書き方のため問題ない）
- 材料の仕入れ区分が「保健所許可のある場所で自家製造する」の場合に、施設名・施設住所が空欄・未記載である点の指摘（このフォームには自家製造を選んだ場合の施設名・住所を入力する欄自体が存在せず、出店者自身の住所・店名が施設情報を兼ねる設計のため、空欄で問題ない。記入を求める指摘は出店者が対応できないので絶対にしないこと）
- 調理方法・その他調理方法欄に何らかの加熱調理を示す記載があり、それが「温める」「あたためる」という言葉自体でない場合、その加熱が実質的に「温める」と同じ行為ではないか、加熱の程度が十分か、といった深読みした指摘（仕込み済みの食品を会場で再加熱する場合であっても、「温める」という言葉さえ使っていなければ表現として十分なので、それ以上の具体性・詳しさは求めない）
- 保存方法の欄は既に確認済みです。仕込みから会場までの運搬中の温度管理・輸送方法について、仕込み内容欄等に追加の説明を求める指摘はしないでください
- 保存方法（常温・冷蔵・冷凍・その他のいずれか）の選択が適切かどうかの判断・指摘は一切しないでください。常温保存の妥当性は機械チェックで別途判定済みです。「この食品は普通こう保存されるはず」といった一般知識との比較か、他の欄の記載との比較かにかかわらず、保存方法の選択そのものについてAIチェックでは判断しないこと
- 材料（野菜・海鮮・生の果物・肉類・麺類・卵など）が十分に加熱されているかどうかの判断・指摘（機械チェックとフォーム上の案内文で別途対応済みのため対象外。AIチェックでは一切判断しないこと）
- ひき肉から成形する必要がある食品（ハンバーグ等）について、仕込みが「仕込みなし」になっている場合に、生のひき肉から成形したのか市販の成形済み品を使っているのかを尋ねたり、成形作業は仕込みとして記載が必要ではないかと指摘したりすること（「仕込みなし」が選ばれている時点で、現地では成形等の下ごしらえを行わない前提として扱ってよい）
- コーヒー豆を当日・会場でその場で挽く／粉にする点の判断・指摘（機械チェックで別途対応済みのため対象外。「豆」をその場に持ち込んで挽く旨が明記されている場合のみ、機械チェック側で判定するので、AIチェックでは一切判断しないこと。材料欄と他の欄の記載の整合性については最重要ルール２を参照）

指摘してほしいのは、たとえば以下のような機械的チェックをすり抜ける矛盾です:
- 食品名と調理方法が明らかに矛盾している（例：トーストと書いてあるのに調理方法が「蒸す」）
- 材料欄と調理方法の説明が食い違っている
- 冷凍食品を扱っているのに冷凍食品の表示に触れられていない
- その他、明らかに保健所で差し戻されそうな矛盾

問題がなければ items を空配列にしてください。過剰な指摘はしないでください（迷ったら指摘しない）。

指摘する場合のmessageは、出店者が読んですぐ動けるように、直し方を1つだけ短く伝えてください。「Aの場合はこう直す、Bの場合はこう直す、逆にCの場合は…」のような場合分けをした長い説明や、複数の直し方を並べることはしないでください。一番可能性が高い直し方を1つだけ提案してください。

入力されたJSONのキー名（drinkPermitFacilityNameのような英語のプログラム変数名）を、messageの中にそのまま書かないでください。出店者はこれらの変数名を知らないので、必ず日本語のフォーム上の項目名・呼び方（例：「清涼飲料水の許可施設の欄」）で説明してください。

必ず以下のJSON形式のみで返答してください:
{
  "items": [
    { "field": "該当するフィールド名（自由記述可、日本語で分かる名前でよい）", "message": "具体的な指摘内容と直し方" }
  ]
}`;

  // コーヒー関連の提出物は、仕込み内容欄・その他調理方法欄の豆・焙煎関連ワードをAIに見せる前に除去する
  // （英語表記「coffee」もisCoffeeFoodNameと同じ基準で拾う）
  const coffeeItemText = [d.foodName, ...(d.ingredients || [])].filter(Boolean).join(' ');
  const isCoffeeItem = coffeeItemText.includes('コーヒー') || coffeeItemText.includes('珈琲') || /coffee/i.test(coffeeItemText);
  const dForAI = isCoffeeItem
    ? { ...d, prepDetail: stripCoffeeBeanProcessWording(d.prepDetail), cookingMethodOther: stripCoffeeBeanProcessWording(d.cookingMethodOther) }
    : d;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    system: systemPrompt,
    messages: [
      { role: 'user', content: `以下の入力内容を確認してください。\n\n${JSON.stringify(humanizeSubmission(dForAI), null, 2)}` },
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

// ===== Google Sheets 読み込み・削除で共有するクライアント =====
function getSheetsClient() {
  if (!process.env.GOOGLE_CREDENTIALS_JSON) return null;
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

// ===== Google Sheets 読み込み（申し込み一覧・まとめダウンロード用） =====
async function readSubmissionRows() {
  const sheets = getSheetsClient();
  if (!sheets) return [];

  const spreadsheetId = process.env.SPREADSHEET_ID;
  const sheetName = process.env.SHEET_NAME || '臨時出店フォーム受付';

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A2:I`,
  });

  const rows = res.data.values || [];
  return rows.map((row, i) => ({
    rowNumber: i + 2,
    timestamp: row[0] || '',
    shopName: row[1] || '',
    businessTypeLabel: row[5] || '',
    foodName: row[6] || '',
    pdfLink: row[7] || '',
    dataJson: row[8] || '',
  }));
}

// ===== 申し込み行の削除（対応するDrive上のPDFも削除） =====
async function deleteSubmissionRow(rowNumber) {
  const sheets = getSheetsClient();
  if (!sheets) throw new Error('GOOGLE_CREDENTIALS_JSON未設定');

  const spreadsheetId = process.env.SPREADSHEET_ID;
  const sheetName = process.env.SHEET_NAME || '臨時出店フォーム受付';

  const rows = await readSubmissionRows();
  const target = rows.find((r) => r.rowNumber === rowNumber);

  if (target && target.pdfLink) {
    const match = target.pdfLink.match(/\/d\/([^/]+)/);
    const auth = getOAuth2Client();
    if (match && auth) {
      const drive = google.drive({ version: 'v3', auth });
      await drive.files.delete({ fileId: match[1] }).catch((e) => {
        console.error('Drive PDF削除エラー:', e.message);
      });
    }
  }

  const meta = await sheets.spreadsheets.get({ spreadsheetId });
  const sheet = meta.data.sheets.find((s) => s.properties.title === sheetName);
  if (!sheet) throw new Error(`シート「${sheetName}」が見つかりません`);

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          deleteDimension: {
            range: {
              sheetId: sheet.properties.sheetId,
              dimension: 'ROWS',
              startIndex: rowNumber - 1,
              endIndex: rowNumber,
            },
          },
        },
      ],
    },
  });
}

function requireAdminKey(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ ok: false, error: '管理用キーが違います。' });
  }
  next();
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

function formatJapaneseDate(date) {
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

// ===== 臨時出店届PDFの生成（テンプレートを複製→差し込み→PDF書き出し、Bufferを返す） =====
// dateText: {{提出日}}{{確認日}}に入れる文字列。個別送信時は空欄、まとめダウンロード時はその日の日付。
async function renderSubmissionPdfBuffer(d, dateText) {
  const auth = getOAuth2Client();
  if (!auth || !process.env.PDF_TEMPLATE_ID) {
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

  const isRestaurant = d.businessType === 'restaurant';
  const ingredients = d.ingredients || [];
  const replacements = {
    '{{住所}}': d.address,
    '{{店名}}': d.shopName,
    '{{氏名}}': d.personName,
    '{{電話番号}}': d.phone,
    '{{取扱食品}}': d.foodName,
    '{{提供数}}': d.servingCount || '',
    '{{累計出店日数}}': d.cumulativeDays,
    '{{提出日}}': dateText || '',
    '{{確認日}}': dateText || '',
  };

  if (isRestaurant) {
    Object.assign(replacements, {
      '{{材料1}}': ingredients[0] || '',
      '{{材料2}}': ingredients[1] || '',
      '{{材料3}}': ingredients[2] || '',
      '{{購入先区分}}': d.ingredientSourceType === 'selfmade'
        ? '□  A 購入先アリ ☑  B 許可のある施設で製造'
        : '☑  A 購入先アリ □  B 許可のある施設で製造',
      '{{購入先名前}}': !isBlank(d.drinkPermitFacilityName)
        ? d.drinkPermitFacilityName
        : d.ingredientSourceType === 'selfmade' ? '自社（保健所許可施設で製造）' : d.ingredientSourceName,
      '{{購入先住所}}': !isBlank(d.drinkPermitFacilityAddress)
        ? d.drinkPermitFacilityAddress
        : d.ingredientSourceType === 'selfmade' ? '' : d.ingredientSourceAddress,
      '{{仕込み区分}}': d.prep === 'onsite'
        ? '□  A なし ☑  B 許可のある施設で当日仕込み'
        : '☑  A なし □  B 許可のある施設で当日仕込み',
      '{{仕込先名前}}': d.prep === 'onsite' ? d.prepFacilityName : '',
      '{{仕込先住所}}': d.prep === 'onsite' ? d.prepFacilityAddress : '',
      '{{仕込み内容}}': d.prep === 'onsite' ? d.prepDetail : 'なし',
      '{{調理方法}}': COOKING_METHOD_LABELS[d.cookingMethod] || d.cookingMethodOther || '',
      '{{保存方法}}': STORAGE_LABELS[d.storage] || d.storageOther || '',
      '{{提供方法}}': (d.serveMethod || []).map((m) => SERVE_METHOD_LABELS[m] || d.serveMethodOther).join('、'),
      '{{物販仕入区分}}': '□  A 購入 □  B 許可のある施設で製造したものを販売',
      '{{物販仕入先名前}}': '',
      '{{物販仕入先住所}}': '',
      '{{物販販売方法}}': '',
      '{{物販冷凍表示}}': '',
      '{{物販保存方法}}': '',
    });
  } else {
    Object.assign(replacements, {
      '{{材料1}}': '',
      '{{材料2}}': '',
      '{{材料3}}': '',
      '{{購入先区分}}': '□  A 購入先アリ □  B 許可のある施設で製造',
      '{{購入先名前}}': '',
      '{{購入先住所}}': '',
      '{{仕込み区分}}': '□  A なし □  B 許可のある施設で当日仕込み',
      '{{仕込先名前}}': '',
      '{{仕込先住所}}': '',
      '{{仕込み内容}}': '',
      '{{調理方法}}': '',
      '{{保存方法}}': '',
      '{{提供方法}}': '',
      '{{物販仕入区分}}': d.selfMade === 'yes'
        ? '□  A 購入 ☑  B 許可のある施設で製造したものを販売'
        : '☑  A 購入 □  B 許可のある施設で製造したものを販売',
      '{{物販仕入先名前}}': d.selfMade === 'yes' ? d.facilityName : d.supplierName,
      '{{物販仕入先住所}}': d.selfMade === 'yes' ? d.facilityAddress : d.supplierAddress,
      '{{物販販売方法}}': d.packagingConfirmed ? '☑ 包装済み完成品を販売する（表示ラベルあり）' : '□ 包装済み完成品を販売する（表示ラベルあり）',
      '{{物販冷凍表示}}': (d.isFrozen && d.frozenLabelConfirmed) ? '／☑冷凍食品である旨の表示あり' : '',
      '{{物販保存方法}}': STORAGE_LABELS[d.storage] || d.storageOther || '',
    });
  }

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

  await drive.files.delete({ fileId: documentId });

  return Buffer.from(exportRes.data);
}

// ===== 個別送信時のPDF生成（日付は空欄のまま、Driveに保存してリンクを返す） =====
async function generateSubmissionPdf(d) {
  const buffer = await renderSubmissionPdfBuffer(d, '');
  if (!buffer) return null;

  const auth = getOAuth2Client();
  const drive = google.drive({ version: 'v3', auth });
  const pdfRes = await drive.files.create({
    requestBody: {
      name: `臨時出店届_${d.shopName}.pdf`,
      parents: process.env.PDF_FOLDER_ID ? [process.env.PDF_FOLDER_ID] : undefined,
    },
    media: { mimeType: 'application/pdf', body: Readable.from(buffer) },
    fields: 'id, webViewLink',
  });

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

// ===== 申し込み一覧（管理用） =====
app.get('/api/submissions', requireAdminKey, async (req, res) => {
  try {
    const rows = await readSubmissionRows();
    res.json({
      ok: true,
      rows: rows.map((r) => ({
        rowNumber: r.rowNumber,
        timestamp: r.timestamp,
        shopName: r.shopName,
        businessTypeLabel: r.businessTypeLabel,
        foodName: r.foodName,
        pdfLink: r.pdfLink,
      })),
    });
  } catch (error) {
    console.error('一覧取得エラー:', error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ===== 申し込み行の削除（管理用） =====
app.delete('/api/submissions/:rowNumber', requireAdminKey, async (req, res) => {
  try {
    const rowNumber = Number(req.params.rowNumber);
    if (!Number.isInteger(rowNumber) || rowNumber < 2) {
      return res.status(400).json({ ok: false, error: '不正なrowNumberです。' });
    }
    await deleteSubmissionRow(rowNumber);
    res.json({ ok: true });
  } catch (error) {
    console.error('申し込み削除エラー:', error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ===== 選択した申し込みをまとめて1つのPDFにして返す（その日の日付を差し込む） =====
app.post('/api/download-merged', requireAdminKey, async (req, res) => {
  try {
    const rowNumbers = Array.isArray(req.body.rowNumbers) ? req.body.rowNumbers : [];
    if (rowNumbers.length === 0) {
      return res.status(400).json({ ok: false, error: 'rowNumbersを指定してください。' });
    }

    const rows = await readSubmissionRows();
    const targets = rows.filter((r) => rowNumbers.includes(r.rowNumber));
    if (targets.length === 0) {
      return res.status(404).json({ ok: false, error: '対象の申し込みが見つかりません。' });
    }

    const { PDFDocument } = require('pdf-lib');
    const merged = await PDFDocument.create();
    const todayText = formatJapaneseDate(new Date());

    for (const t of targets) {
      let d;
      try {
        d = JSON.parse(t.dataJson);
      } catch {
        continue;
      }
      const buffer = await renderSubmissionPdfBuffer(d, todayText);
      if (!buffer) continue;
      const src = await PDFDocument.load(buffer);
      const copiedPages = await merged.copyPages(src, src.getPageIndices());
      copiedPages.forEach((p) => merged.addPage(p));
    }

    if (merged.getPageCount() === 0) {
      return res.status(422).json({ ok: false, error: '選択した申し込みからPDFを1件も作成できませんでした。' });
    }

    const mergedBytes = await merged.save();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="shutten-todoke-matome.pdf"; filename*=UTF-8''${encodeURIComponent('臨時出店届_まとめ.pdf')}`
    );
    res.send(Buffer.from(mergedBytes));
  } catch (error) {
    console.error('PDFまとめエラー:', error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3010;
app.listen(PORT, () => {
  console.log(`臨時出店届フォーム running at http://localhost:${PORT}`);
});
