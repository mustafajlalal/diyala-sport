# النشر المجاني خطوة بخطوة (بدون برمجة)

الاستضافة: **Render** (مجانية، بدون بطاقة) + **Upstash** (قاعدة بيانات مجانية حتى ما تضيع حساباتك).
كل شي تسويه من المتصفح.

## 1) ارفع المشروع على GitHub
1. سوّي حساب على github.com ← New repository ← الاسم `academic-writer` ← Create.
2. اضغط "uploading an existing file" واسحب **محتويات** المجلد (بعد فك الـ zip) مو الـ zip نفسه، ثم Commit.
   (تأكد إن ملف `package.json` ظاهر بالصفحة الرئيسية للمستودع.)

## 2) سوّي قاعدة البيانات المجانية (Upstash)
1. console.upstash.com ← سجّل ← Create Database ← Redis ← اسم أي شي ← Create.
2. انزل لقسم REST API وانسخ قيمتين: `UPSTASH_REDIS_REST_URL` و `UPSTASH_REDIS_REST_TOKEN`.

## 3) انشر على Render
1. render.com ← سجّل بحساب GitHub ← New ← **Blueprint** ← اختر المستودع ← Apply.
2. اكتب القيم اللي يطلبها:
   - `ADMIN_EMAIL` = إيميلك (هو الأدمن الوحيد)
   - `GEMINI_API_KEY` = مفتاحك من aistudio.google.com (اختياري؛ بدونه يشتغل المحرك المحلي)
   - `UPSTASH_REDIS_REST_URL` و `UPSTASH_REDIS_REST_TOKEN` = من الخطوة 2
3. انتظر البناء (5-10 دقايق) ويطلع لك رابط مثل `https://academic-writer.onrender.com`.

## 4) أهم خطوة
افتح الرابط وسجّل حساب بنفس إيميل `ADMIN_EMAIL` **فوراً** حتى تصير أنت الأدمن.

## ملاحظات
- المجاني ينام بعد 15 دقيقة بدون زوار، وأول فتح بعدها ياخذ 30-50 ثانية.
- لا تفعّل `VITE_ALLOW_LOCAL_MODE` أبداً.
- إذا مفتاح Gemini أو الـ zip القديم انكشف قبل، غيّر المفتاح.
- حدود المجاني تتغير، راجع صفحات Render وUpstash قبل الاعتماد عليه.
