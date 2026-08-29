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
  season: '味付けする', pour: '一杯ずつカップに抽出する', plate: 'よそう（盛り付ける）',
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
// 野菜は専用の文言（「生野菜」）を出し、それ以外（麺・肉・魚介・卵）はカテゴリごとに文言を
// 増やすとパターンが際限なく増えるため、まとめて「生の食材」という汎用文言で扱う
const RAW_VEGETABLE_KEYWORDS = ['きゅうり', 'レタス', 'トマト', 'キャベツ', '水菜', 'パクチー', 'もやし', '生野菜', '生の野菜', '生の果物'];
const RAW_OTHER_KEYWORDS = ['焼きそば', 'そば', 'うどん', 'ラーメン', 'パスタ', '麺', '豚肉', '鶏肉', '牛肉', 'ひき肉', '魚', 'エビ', 'イカ', 'タコ', '卵'];
const RAW_OR_HEAT_NEEDED_KEYWORDS = [...RAW_VEGETABLE_KEYWORDS, ...RAW_OTHER_KEYWORDS];
// 生食材ヒットのカテゴリに応じて文言を出し分ける
function rawFoodMessage(text) {
  if (containsAny(text, RAW_VEGETABLE_KEYWORDS)) {
    return '生野菜の使用は許可が通らないことが多いです。焼くことを記載するか、記載から省いてください。';
  }
  return '生の食材の使用は許可が通らないことが多いです。焼くことを記載するか、記載から省いてください。';
}
// 実際に加熱する調理方法（これ以外は「加熱した」と見なさない）
const HEAT_COOKING_METHODS = ['grill', 'boil', 'steam', 'fry'];
// 調理方法「その他」の自由記述が実質的に加熱調理と読み取れるかの判定に使う言葉
const HEAT_WORD_KEYWORDS = ['加熱', '焼く', '焼いて', '焼いた', '煮る', '煮て', '煮た', '蒸す', '蒸して', '蒸した', '揚げる', '揚げて', '揚げた'];
// 常温保存でも問題ない食品（これに該当しなければ常温は警告対象）
const DRY_SAFE_KEYWORDS = ['乾麺', '乾き物', '乾物', 'せんべい', 'クッキー', 'ビスケット', '飴', 'キャンディ', 'ポップコーン', 'スナック', 'ドライフルーツ', '焼き菓子', '駄菓子', 'チップス', 'ナッツ', 'コーヒー粉', 'ドリップパック', '茶葉', 'ティーバッグ'];
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
// texts は個別のフィールドごとの配列で渡すこと（結合してから判定すると、別欄の記載が判定を隠して
// しまう＝分割記載によるすり抜けを防ぐため）。該当する分は全部集めて配列で返す
function detectCitrusIssues(texts) {
  const list = Array.isArray(texts) ? texts : [texts];
  const results = [];
  const seen = new Set();
  for (const text of list) {
    if (!text) continue;
    for (const k of RAW_CITRUS_DRINK_KEYWORDS) {
      if (!text.includes(k)) continue;
      const isProcessed = text.includes(`${k}シロップ`) || text.includes(`${k}果汁`);
      if (isProcessed) continue;
      if (!seen.has(k)) {
        seen.add(k);
        results.push({ type: 'raw', fruit: k });
      }
    }
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
  const brewingMethod = d.cookingMethod === 'other' || d.cookingMethod === 'pour';
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
    return '茶葉の使用は許可がおりません。許可をもらうため、食材には「市販のティーバッグ」と記載して、下の調理方法は「一杯ずつカップに抽出する」を選択してください。';
  }
  return 'まとめて作り置きは許可がおりません。許可をもらうため、市販のバッグで一杯ずつ抽出すると記載してください。';
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
// キーワード方式なので完璧ではない（想定外の言い回しは拾いきれない）。判定に迷うケースはAIチェック側で拾う想定
const GRIND_KEYWORDS = ['挽く', '挽いて', '挽き', '挽いた', '粉にする', '粉にして', '粉にした'];
const PRE_GROUND_KEYWORDS = ['事前に', 'あらかじめ', '挽いてある', '粉にしてある', '挽いたもの', '挽き済み', '仕入れ'];
function detectGroundOnSiteCoffee(d) {
  const text = [d.foodName, ...(d.ingredients || []), d.cookingMethodOther].filter(Boolean).join(' ');
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

      // ingredients欄だけでなく、その他欄・仕込み内容にハム/チーズ等が書かれるケースも拾う
      // 「具材」は仕込み内容側で専用チェックするので、ここでは仕込み内容を対象にしない
      const extendedFields = [...ingredients, d.cookingMethodOther, d.prepDetail];
      if (detectHamCheese(extendedFields).length > 0) {
        issues.push('「ハム」「チーズ」を記載すると通らないことが多いです。許可をもらうため、他の食材を記入してください。');
      }
      if (detectVagueFillingWord([...ingredients, d.cookingMethodOther])) {
        issues.push('「具材」だけだと許可が通らないことが多いため、具体的な食材を2つほど記載してください。');
      }
      if (detectNonPlantWhipCream(extendedFields)) {
        issues.push('ホイップクリームは許可をもらうため、「植物性ホイップクリーム」と記入してください。');
      }
      if (detectNonDisposableDripper(extendedFields)) {
        issues.push('ドリッパーは「使い捨て」か「市販のカセット式」以外は使用できません。（使い捨てドリッパーは30円で目黒マルシェで販売しています）。');
      }

      // コーヒーの材料欄に「豆」とだけ書く、または「珈琲豆」「コーヒー豆」と書くと通らない
      if (isCoffeeFoodName(d.foodName) && detectCoffeeBeanWording(ingredients)) {
        issues.push('「豆」と書くと通らないので、材料欄には「コーヒー粉」「ドリップパック」などと記載してください。');
      }

      // 生の柑橘（レモン等）をそのまま使う記載は許可が通らない（複数あれば全部）。
      // シロップとしての自家製／市販の扱いは drinkPermitFacility の統一ルールで別途判定する
      const citrusIssues = detectCitrusIssues([d.foodName, ...ingredients, d.cookingMethodOther]);
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
      } else if (detectWeakHeatWord(d.cookingMethodOther)) {
        // 「温める」系の言葉は曖昧チェックにも該当するが、こちらの方が具体的なので優先する
        const hasCrepe = [d.foodName, ...(d.ingredients || []), d.cookingMethodOther].filter(Boolean).join(' ').includes(CREPE_KEYWORD);
        errors.cookingMethodOther = weakHeatWordMessage(hasCrepe);
      } else if (detectGroundOnSiteCoffee(d)) {
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

    // コーヒー豆をその場で挽くのは不可（cookingMethod='pour'等、その他欄を使わないケース）
    if (!errors.ingredients && !errors.cookingMethodOther && detectGroundOnSiteCoffee(d)) {
      errors.ingredients = '豆をその場で粉にすることを記載すると通りません。';
    }

    // コーヒー・紅茶等をまとめて作り置きするのは許可が通らない（cookingMethod='pour'等、その他欄を使わないケース）
    if (!errors.ingredients && !errors.cookingMethodOther && detectBulkBrewedDrink(d)) {
      errors.ingredients = bulkBrewedDrinkMessage(detectBulkBrewedDrink(d));
    }

    // 生のまま提供されやすい／加熱が前提の食材なのに、実際に加熱する調理方法が選ばれていない。
    // 「その他」は自由記述の中身に加熱を示す言葉があれば加熱調理とみなす（固定の調理方法以外は
    // 一律NGにすると、その他を選んで「食材を焼く」等と具体的に書いても永久に解除できなくなるため）
    if (!errors.ingredients && !errors.cookingMethod) {
      const rawText = [d.foodName, ...(d.ingredients || [])].filter(Boolean).join(' ');
      const rawHit = containsAny(rawText, RAW_OR_HEAT_NEEDED_KEYWORDS);
      const isHeated = HEAT_COOKING_METHODS.includes(d.cookingMethod)
        || (d.cookingMethod === 'other' && Boolean(containsAny(d.cookingMethodOther, HEAT_WORD_KEYWORDS)));
      if (rawHit && !isHeated) {
        errors.cookingMethod = rawFoodMessage(rawText);
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

// フォーム内部のコード値（例：cookingMethod="boil"）をそのままAIに渡すと、
// 英単語の意味（boil=茹でる）につられて誤判定することがある（実際に「boil」を
// 「食材と水を鍋で煮る」の意味で使っているのに「茹でる」と誤解された事例あり）。
// PDF表示と同じ日本語ラベルに変換してからAIに渡すことで、この種の誤判定を防ぐ
// 「その他」（コード値"other"）はラベル対応表に存在しないため、PDF生成と同じく
// 自由記述欄の中身にフォールバックする（それも空ならコード値のまま残す）
function humanizeSubmission(d) {
  const h = { ...d };
  if (d.cookingMethod) h.cookingMethod = COOKING_METHOD_LABELS[d.cookingMethod] || d.cookingMethodOther || d.cookingMethod;
  if (d.storage) h.storage = STORAGE_LABELS[d.storage] || d.storageOther || d.storage;
  if (Array.isArray(d.serveMethod)) h.serveMethod = d.serveMethod.map((m) => SERVE_METHOD_LABELS[m] || d.serveMethodOther || m);
  return h;
}

// ===== AI意味チェック（構造では防げない食品衛生の妥当性判断） =====
async function aiSemanticCheck(d) {
  const systemPrompt = `あなたは目黒マルシェの「臨時出店届」の内容を確認する担当者です。
入力されたJSONの内容を見て、食品衛生上・記載内容として不自然・矛盾している点だけを指摘してください。
以下はすでに機械的にチェック済みなので、指摘不要です:
- 必須項目の空欄
- 業態区分の二重選択
- 禁止材料（牛乳）の使用
- ご飯類（ご飯・白米・ライス・おにぎり・カレーライス）をその場でよそう提供の指摘
- 現場の調理方法・その他調理方法欄での「茹でる」（大量の水を使う調理）の指摘（仕込み内容欄は許可施設で行う前提のため対象外。仕込み内容欄に「茹でる」とあっても指摘不要）
- 購入先の空欄・海外住所
- シロップ・果汁・コーディアル系ドリンク（柑橘の自家製シロップ含む）の清涼飲料水製造業許可の指摘（drinkPermitFacilityName・drinkPermitFacilityAddressに記入がある、または材料欄等に「市販」と明記されていれば、許可施設の記載要件は既に満たされているので指摘不要）
- 生のレモン・ライム等をドリンクにそのまま使う点の指摘
- コーヒー・紅茶等をまとめて作り置きする点の指摘（市販ティーバッグ・ドリップバッグへの変更）
- コーヒーのドリッパーが「使い捨て」でも「カセット式」でもない点の指摘
- コーヒーの材料欄に「豆」とだけ、または「珈琲豆」「コーヒー豆」と書かれている点の指摘（「コーヒー粉」「ドリップパック」への変更）
- 「温める」「あたためる」という言葉自体が使用不可な点の指摘
- 「具材」という曖昧な記載の指摘
- ホイップクリームの植物性明記漏れの指摘
- クレープの現地調理（前日仕込み・温め提供は不可）の指摘

指摘してほしいのは、たとえば以下のような機械的チェックをすり抜ける矛盾です:
- 食品名と調理方法が明らかに矛盾している（例：トーストと書いてあるのに調理方法が「蒸す」）
- 材料欄と調理方法の説明が食い違っている
- 冷凍食品を扱っているのに冷凍食品の表示に触れられていない
- コーヒーを扱う場合、豆をその場（当日・会場）で挽く／粉にすることが読み取れる記載（キーワードだけでは判定しきれない曖昧な言い回しも含めて判断してください。仕入れ時点で挽いてある・市販の挽き豆を使う旨が明記されていれば問題ありません）
- その他、明らかに保健所で差し戻されそうな矛盾

海鮮・生野菜・生の果物・肉類・麺類・卵など「要冷蔵の生食材」については、キーワードだけで機械的に禁止はしていません。以下の考え方で判断してください:
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
      { role: 'user', content: `以下の入力内容を確認してください。\n\n${JSON.stringify(humanizeSubmission(d), null, 2)}` },
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
    '{{提供数}}': isRestaurant ? d.servingCount : '',
    '{{累計出店日数}}': d.cumulativeDays,
    '{{提出日}}': dateText || '',
    '{{確認日}}': dateText || '',
  };

  if (isRestaurant) {
    Object.assign(replacements, {
      '{{材料1}}': ingredients[0] || '',
      '{{材料2}}': ingredients[1] || '',
      '{{材料3}}': ingredients[2] || '',
      '{{購入先名前}}': !isBlank(d.drinkPermitFacilityName)
        ? d.drinkPermitFacilityName
        : d.ingredientSourceType === 'selfmade' ? '自社（保健所許可施設で製造）' : d.ingredientSourceName,
      '{{購入先住所}}': !isBlank(d.drinkPermitFacilityAddress)
        ? d.drinkPermitFacilityAddress
        : d.ingredientSourceType === 'selfmade' ? '' : d.ingredientSourceAddress,
      '{{仕込先名前}}': d.prep === 'onsite' ? d.prepFacilityName : '',
      '{{仕込先住所}}': d.prep === 'onsite' ? d.prepFacilityAddress : '',
      '{{仕込み内容}}': d.prep === 'onsite' ? d.prepDetail : 'なし',
      '{{調理方法}}': COOKING_METHOD_LABELS[d.cookingMethod] || d.cookingMethodOther || '',
      '{{保存方法}}': STORAGE_LABELS[d.storage] || d.storageOther || '',
      '{{提供方法}}': (d.serveMethod || []).map((m) => SERVE_METHOD_LABELS[m] || d.serveMethodOther).join('、'),
      '{{物販仕入先名前}}': '',
      '{{物販仕入先住所}}': '',
      '{{物販販売方法}}': '',
      '{{物販保存方法}}': '',
    });
  } else {
    Object.assign(replacements, {
      '{{材料1}}': '',
      '{{材料2}}': '',
      '{{材料3}}': '',
      '{{購入先名前}}': '',
      '{{購入先住所}}': '',
      '{{仕込先名前}}': '',
      '{{仕込先住所}}': '',
      '{{仕込み内容}}': '',
      '{{調理方法}}': '',
      '{{保存方法}}': '',
      '{{提供方法}}': '',
      '{{物販仕入先名前}}': d.selfMade === 'yes' ? d.facilityName : d.supplierName,
      '{{物販仕入先住所}}': d.selfMade === 'yes' ? d.facilityAddress : d.supplierAddress,
      '{{物販販売方法}}': d.packagingConfirmed ? '☑ 包装済み完成品を販売する(表示ラベルあり)' : '□ 包装済み完成品を販売する(表示ラベルあり)',
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
