const { onRequest } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const fetch = require("node-fetch");

initializeApp();
const db = getFirestore();

const COURSES = {
  "scripts":       { amount: 48900,  name: "Скрипти продажів. Переписка яка продає" },
  "warm-base":     { amount: 58000,  name: "Тепла база клієнтів" },
  "money-mindset": { amount: 120000, name: "Психологія грошей" },
  "entrepreneur":  { amount: 100000, name: "Початковий підприємець" },
  "upsell":        { amount: 70000,  name: "Допродажі в переписці" },
  "sales-funnel":  { amount: 59900,  name: "Воронка продажів" },
};

exports.createInvoice = onRequest(
  { region: "europe-west1", invoker: "public" },
  async (req, res) => {
    if (req.method !== "POST") { res.status(405).send("Method Not Allowed"); return; }

    const { courseId, name, email } = req.body;
    const course = COURSES[courseId];
    if (!course) { res.status(400).json({ error: "Unknown course" }); return; }

    const MONO_TOKEN = process.env.MONO_TOKEN;

    const payload = {
      amount: course.amount,
      ccy: 980,
      redirectUrl: "https://yakovenko-school.web.app/thank-you.html",
      webHookUrl: "https://europe-west1-yakovenko-school.cloudfunctions.net/monoWebhook",
      validity: 3600,
      merchantPaymInfo: {
        reference: `${courseId}_${Date.now()}`,
        destination: `Курс: ${course.name}`,
        basketOrder: [{
          name: course.name,
          qty: 1,
          sum: course.amount,
          total: course.amount,
          unit: "шт",
        }],
      },
    };

    try {
      const monoRes = await fetch("https://api.monobank.ua/api/merchant/invoice/create", {
        method: "POST",
        headers: {
          "X-Token": MONO_TOKEN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
      const data = await monoRes.json();
      if (!monoRes.ok) {
        console.error("Mono error:", JSON.stringify(data));
        res.status(500).json({ error: "Payment error" });
        return;
      }

      db.collection("invoices").doc(data.invoiceId).set({
        invoiceId: data.invoiceId,
        courseId,
        courseName: course.name,
        amount: course.amount,
        name: name || "",
        email: email || "",
        status: "created",
        pageUrl: data.pageUrl,
        createdAt: new Date(),
      }).catch(err => console.error("Firestore write error:", err.message));

      res.json({ pageUrl: data.pageUrl });
    } catch (err) {
      console.error("Error:", err.message);
      res.status(500).json({ error: "Internal error" });
    }
  }
);

exports.monoWebhook = onRequest(
  { region: "europe-west1", invoker: "public" },
  async (req, res) => {
    const { invoiceId, status, amount, reference } = req.body;
    console.log(`Webhook: invoiceId=${invoiceId} status=${status} amount=${amount} ref=${reference}`);
    if (invoiceId) {
      await db.collection("invoices").doc(invoiceId).update({
        status,
        updatedAt: new Date(),
      }).catch(() => {});
    }
    res.status(200).send("ok");
  }
);

exports.clearStats = onRequest(
  { region: "europe-west1", invoker: "public" },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }

    const auth = req.headers.authorization || "";
    if (auth !== `Bearer ${process.env.ADMIN_PASSWORD}`) {
      res.status(401).json({ error: "Unauthorized" }); return;
    }

    const { collection } = req.body;
    if (!["invoices", "leads", "pageViews"].includes(collection)) {
      res.status(400).json({ error: "Invalid collection" }); return;
    }

    try {
      let deleted = 0, snap;
      do {
        snap = await db.collection(collection).limit(400).get();
        if (snap.empty) break;
        const batch = db.batch();
        snap.docs.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
        deleted += snap.size;
      } while (snap.size === 400);
      res.json({ ok: true, deleted });
    } catch (err) {
      console.error(err.message);
      res.status(500).json({ error: "Internal error" });
    }
  }
);

exports.trackPageView = onRequest(
  { region: "europe-west1", invoker: "public" },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    const page = (req.body && req.body.page) || "/";
    const sessionId = (req.body && req.body.sessionId) || "";
    db.collection("pageViews").add({ page, sessionId, timestamp: new Date() }).catch(() => {});
    res.json({ ok: true });
  }
);

exports.trackLead = onRequest(
  { region: "europe-west1", invoker: "public" },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    if (req.method !== "POST") { res.status(405).send("Method Not Allowed"); return; }

    const { courseId, name, email } = req.body;
    if (!name || !email) { res.status(400).json({ error: "Missing fields" }); return; }

    const course = COURSES[courseId];
    db.collection("leads").add({
      courseId,
      courseName: course ? course.name : courseId,
      name,
      email,
      createdAt: new Date(),
    }).catch(err => console.error("Firestore leads error:", err.message));
    res.json({ ok: true });
  }
);

exports.getAdminData = onRequest(
  { region: "europe-west1", invoker: "public" },
  async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
    if (req.method === "OPTIONS") { res.status(204).send(""); return; }

    const auth = req.headers.authorization || "";
    const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
    if (auth !== `Bearer ${ADMIN_PASSWORD}`) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    try {
      const [invoicesSnap, leadsSnap, pageViewsSnap] = await Promise.all([
        db.collection("invoices").orderBy("createdAt", "desc").limit(500).get(),
        db.collection("leads").orderBy("createdAt", "desc").limit(500).get(),
        db.collection("pageViews").orderBy("timestamp", "desc").limit(5000).get(),
      ]);
      const invoices = invoicesSnap.docs.map(doc => doc.data());
      const leads = leadsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      const pageViews = pageViewsSnap.docs.map(doc => doc.data());
      res.json({ invoices, leads, pageViews });
    } catch (err) {
      console.error(err.message);
      res.status(500).json({ error: "Internal error" });
    }
  }
);
