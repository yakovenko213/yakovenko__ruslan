const { onRequest } = require("firebase-functions/v2/https");
const fetch = require("node-fetch");

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
    if (status === "success") {
      // TODO: надіслати email підтвердження, видати доступ до курсу
    }
    res.status(200).send("ok");
  }
);
