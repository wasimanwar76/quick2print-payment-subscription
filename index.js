require("dotenv").config();

const express = require("express");

const cors = require("cors");

const crypto = require("crypto");

const { createClient } = require("@supabase/supabase-js");

const app = express();

app.use(cors());

app.use(express.json({ limit: "2mb" }));

const PORT = Number(process.env.PORT || 5000);

const SUPABASE_URL = process.env.SUPABASE_URL;

const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

const CASHFREE_APP_ID = process.env.CASHFREE_APP_ID;

const CASHFREE_SECRET_KEY = process.env.CASHFREE_SECRET_KEY;

const CASHFREE_ENV = String(
  process.env.CASHFREE_ENV || "SANDBOX",
).toUpperCase();

const RETURN_URL = "https://www.quick2print.in/subscription-payment-success.html";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY)
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");

if (!CASHFREE_APP_ID || !CASHFREE_SECRET_KEY)
  throw new Error("Missing CASHFREE_APP_ID or CASHFREE_SECRET_KEY");

if (!["SANDBOX", "PRODUCTION"].includes(CASHFREE_ENV))
  throw new Error("CASHFREE_ENV must be SANDBOX or PRODUCTION");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    autoRefreshToken: false,

    persistSession: false,
  },
});

const CF_BASE =
  CASHFREE_ENV === "PRODUCTION"
    ? "https://api.cashfree.com/pg"
    : "https://sandbox.cashfree.com/pg";

const CF_HEADERS = {
  "Content-Type": "application/json",

  "x-client-id": CASHFREE_APP_ID,

  "x-client-secret": CASHFREE_SECRET_KEY,

  "x-api-version": "2022-09-01",
};

const ok = (res, message, data = {}, status = 200) =>
  res.status(status).json({ success: true, message, data });

const fail = (res, message, code, status = 400, details) =>
  res.status(status).json({
    success: false,

    message,

    error: { code, ...(details ? { details } : {}) },
  });

const text = (v) => String(v ?? "").trim();

function addMonthsUTC(date, months) {
  const d = new Date(date);

  const day = d.getUTCDate();

  d.setUTCDate(1);

  d.setUTCMonth(d.getUTCMonth() + Number(months));

  const last = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
  ).getUTCDate();

  d.setUTCDate(Math.min(day, last));

  return d;
}

async function shop(shopId) {
  const { data, error } = await supabase

    .from("shops")

    .select("shop_id,owner_name,shop_name,whatsapp_number,email,status")

    .eq("shop_id", shopId)

    .maybeSingle();

  if (error) throw error;

  return data;
}

async function plan(planName) {
  let { data, error } = await supabase

    .from("plans")

    .select("plan_id,name,price_inr,duration_months,duration_label")

    .eq("plan_id", planName)

    .maybeSingle();

  if (error) throw error;

  if (data) return data;

  const result = await supabase

    .from("plans")

    .select("plan_id,name,price_inr,duration_months,duration_label")

    .ilike("name", planName)

    .limit(1)

    .maybeSingle();

  if (result.error) throw result.error;

  return result.data;
}

async function cf(path, options = {}) {
  const response = await fetch(`${CF_BASE}${path}`, {
    ...options,

    headers: { ...CF_HEADERS, ...(options.headers || {}) },
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    const e = new Error(
      body?.message || body?.message_text || "Cashfree request failed.",
    );

    e.status = response.status;

    throw e;
  }

  return body;
}

app.post("/api/subscription/create", async (req, res) => {
  try {
    const shopId = text(req.body?.shopId);

    const planName = text(req.body?.planName);

    if (!shopId)
      return fail(
        res,

        "Shop ID is required to start your subscription.",

        "SHOP_ID_REQUIRED",
      );

    if (!planName)
      return fail(
        res,

        "Plan name is required to continue.",

        "PLAN_NAME_REQUIRED",
      );

    const s = await shop(shopId);

    if (!s)
      return fail(
        res,

        "We couldn't find this shop. Please check your Shop ID and try again.",

        "SHOP_NOT_FOUND",

        404,
      );

    if (s.status === "suspended")
      return fail(
        res,

        "This shop is suspended. Please contact Quick2Print support.",

        "SHOP_SUSPENDED",

        403,
      );

    const p = await plan(planName);

    if (!p)
      return fail(
        res,

        "The selected plan is unavailable. Please refresh and try again.",

        "PLAN_NOT_FOUND",

        404,
      );

    const amount = Number(p.price_inr);

    const months = Number(p.duration_months);

    if (!Number.isFinite(amount) || amount <= 0)
      return fail(
        res,

        "This plan does not require an online payment.",

        "PLAN_NOT_PAYABLE",
      );

    if (!Number.isInteger(months) || months <= 0)
      return fail(
        res,

        "This plan has an invalid subscription duration. Please contact support.",

        "INVALID_PLAN_DURATION",

        500,
      );

    const subscriptionId = crypto.randomUUID();

    const orderId = `Q2P_SUB_${Date.now()}_${crypto.randomBytes(5).toString("hex")}`;

    const { error: insertError } = await supabase

      .from("shop_subscriptions")

      .insert({
        subscription_id: subscriptionId,

        shop_id: shopId,

        plan_id: p.plan_id,

        amount,

        currency: "INR",

        duration_months: months,

        cashfree_order_id: orderId,

        payment_status: "PENDING",

        payment_environment: CASHFREE_ENV,
      });

    if (insertError) throw insertError;

    try {
      const cfOrder = await cf("/orders", {
        method: "POST",

        body: JSON.stringify({
          order_id: orderId,

          order_amount: amount,

          order_currency: "INR",

          customer_details: {
            customer_id: `SHOP_${shopId}`,

            customer_name: s.owner_name || s.shop_name || "Quick2Print Shop",

            customer_phone: s.whatsapp_number || "9999999999",

            ...(s.email ? { customer_email: s.email } : {}),
          },

          order_meta: {
            return_url: (() => {
              const url = new URL(RETURN_URL);

              url.searchParams.set("subscription_id", subscriptionId);

              url.searchParams.set("shop_id", shopId);

              return url.toString();
            })(),
          },

          order_note: `Quick2Print ${p.name} subscription`,
        }),
      });

      const sessionId = cfOrder?.payment_session_id;

      if (!sessionId)
        throw new Error("Cashfree did not return a payment session ID.");

      const { error: updateError } = await supabase

        .from("shop_subscriptions")

        .update({
          cashfree_payment_session_id: sessionId,

          updated_at: new Date().toISOString(),
        })

        .eq("subscription_id", subscriptionId);

      if (updateError) throw updateError;

      return ok(
        res,

        `Your ${p.name} subscription payment is ready. Continue to secure payment.`,

        {
          subscription_id: subscriptionId,

          shop_id: shopId,

          plan_id: p.plan_id,

          plan_name: p.name,

          amount,

          currency: "INR",

          duration_months: months,

          duration_label: p.duration_label,

          cashfree_order_id: orderId,

          payment_session_id: sessionId,

          environment: CASHFREE_ENV,
        },

        201,
      );
    } catch (e) {
      await supabase

        .from("shop_subscriptions")

        .update({
          payment_status: "FAILED",

          payment_error_message: e.message,

          updated_at: new Date().toISOString(),
        })

        .eq("subscription_id", subscriptionId);

      throw e;
    }
  } catch (e) {
    console.error("[CREATE SUBSCRIPTION]", e);

    return fail(
      res,

      e.message ||
        "We couldn't start the subscription payment. Please try again.",

      "SUBSCRIPTION_CREATE_FAILED",

      500,
    );
  }
});

app.get("/api/subscription/:subscriptionId", async (req, res) => {
  try {
    const subscriptionId = text(req.params.subscriptionId);
    if (!subscriptionId) {
      return fail(
        res,
        "Subscription ID is required.",
        "SUBSCRIPTION_ID_REQUIRED",
        400,
      );
    }

    const { data: sub, error } = await supabase
      .from("shop_subscriptions")
      .select(
        `
        subscription_id,
        shop_id,
        plan_id,
        amount,
        currency,
        duration_months,
        cashfree_order_id,
        cashfree_payment_session_id,
        payment_status,
        payment_environment,
        payment_method,
        cashfree_payment_id,
        started_at,
        expires_at,
        created_at,
        payment_error_message
      `,
      )
      .eq("subscription_id", subscriptionId)
      .maybeSingle();

    if (error) throw error;
    if (!sub)
      return fail(
        res,
        "Subscription payment was not found.",
        "SUBSCRIPTION_NOT_FOUND",
        404,
      );

    const { data: plan, error: planError } = await supabase
      .from("plans")
      .select("plan_id,name,price_inr,duration_months,duration_label")
      .eq("plan_id", sub.plan_id)
      .maybeSingle();
    if (planError) throw planError;

    const { data: shopData, error: shopError } = await supabase
      .from("shops")
      .select("shop_id,shop_name,owner_name,status")
      .eq("shop_id", sub.shop_id)
      .maybeSingle();
    if (shopError) throw shopError;

    return ok(res, "Subscription details loaded.", {
      ...sub,
      plan_name: plan?.name || sub.plan_id,
      duration_label: plan?.duration_label || `${sub.duration_months} Months`,
      shop_name: shopData?.shop_name || "Quick2Print Shop",
    });
  } catch (e) {
    console.error("[GET SUBSCRIPTION]", e);
    return fail(
      res,
      e.message || "Unable to load subscription details.",
      "SUBSCRIPTION_LOAD_FAILED",
      500,
    );
  }
});

app.post("/api/subscription/verify", async (req, res) => {
  try {
    const subscriptionId = text(req.body?.subscriptionId);

    const shopId = text(req.body?.shopId);

    if (!subscriptionId)
      return fail(
        res,

        "Subscription ID is required for payment verification.",

        "SUBSCRIPTION_ID_REQUIRED",
      );

    if (!shopId)
      return fail(
        res,

        "Shop ID is required for payment verification.",

        "SHOP_ID_REQUIRED",
      );

    const { data: sub, error: subError } = await supabase

      .from("shop_subscriptions")

      .select("*")

      .eq("subscription_id", subscriptionId)

      .eq("shop_id", shopId)

      .maybeSingle();

    if (subError) throw subError;

    if (!sub)
      return fail(
        res,

        "We couldn't find this subscription payment.",

        "SUBSCRIPTION_NOT_FOUND",

        404,
      );

    if (sub.payment_status === "PAID") {
      return ok(
        res,

        "Payment is already verified. Your subscription is active.",

        {
          subscription_id: sub.subscription_id,

          payment_status: "PAID",

          subscription_status: "active",

          plan_id: sub.plan_id,

          plan_expires_at: sub.expires_at,

          subscription_start: sub.started_at,

          subscription_end: sub.expires_at,

          already_processed: true,
        },
      );
    }

    const order = await cf(
      `/orders/${encodeURIComponent(sub.cashfree_order_id)}`,
    );

    const payments = await cf(
      `/orders/${encodeURIComponent(sub.cashfree_order_id)}/payments`,
    );

    const list = Array.isArray(payments) ? payments : [];

    const paid = list.find(
      (x) => String(x?.payment_status || "").toUpperCase() === "SUCCESS",
    );

    const orderStatus = String(order?.order_status || "").toUpperCase();

    if (orderStatus !== "PAID" && !paid) {
      if (["EXPIRED", "TERMINATED"].includes(orderStatus)) {
        await supabase

          .from("shop_subscriptions")

          .update({
            payment_status: "EXPIRED",

            payment_error_message: `Cashfree order status: ${orderStatus}`,

            updated_at: new Date().toISOString(),
          })

          .eq("subscription_id", subscriptionId);

        return fail(
          res,

          "This payment session has expired. Please start a new subscription payment.",

          "PAYMENT_EXPIRED",
        );
      }

      return ok(
        res,

        "Payment is not confirmed yet. Please complete the payment and try again.",

        {
          subscription_id: subscriptionId,

          payment_status: "PENDING",

          cashfree_order_status: orderStatus || "UNKNOWN",
        },
      );
    }

    const paidAmount = Number(paid?.payment_amount ?? order?.order_amount ?? 0);

    const expected = Number(sub.amount);

    if (
      !Number.isFinite(paidAmount) ||
      Math.abs(paidAmount - expected) > 0.01
    ) {
      await supabase

        .from("shop_subscriptions")

        .update({
          payment_status: "FAILED",

          payment_error_message: `Expected ₹${expected}, received ₹${paidAmount}.`,

          updated_at: new Date().toISOString(),
        })

        .eq("subscription_id", subscriptionId);

      return fail(
        res,

        "Payment verification failed because the paid amount does not match the selected plan.",

        "PAYMENT_AMOUNT_MISMATCH",
      );
    }

    const start = new Date();

    const end = addMonthsUTC(start, sub.duration_months);

    const paymentId = paid?.cf_payment_id || paid?.payment_id || null;

    const paymentMethod = paid?.payment_group || null;

    const { data: claimed, error: claimError } = await supabase

      .from("shop_subscriptions")

      .update({
        payment_status: "PAID",

        cashfree_payment_id: paymentId,

        payment_method: paymentMethod,

        started_at: start.toISOString(),

        expires_at: end.toISOString(),

        payment_error_message: null,

        updated_at: new Date().toISOString(),
      })

      .eq("subscription_id", subscriptionId)

      .eq("shop_id", shopId)

      .neq("payment_status", "PAID")

      .select("*")

      .maybeSingle();

    if (claimError) throw claimError;

    if (!claimed) {
      const { data: existing, error } = await supabase

        .from("shop_subscriptions")

        .select("*")

        .eq("subscription_id", subscriptionId)

        .single();

      if (error) throw error;

      return ok(
        res,

        "Payment is already verified. Your subscription is active.",

        {
          subscription_id: existing.subscription_id,

          payment_status: "PAID",

          subscription_status: "active",

          plan_id: existing.plan_id,

          plan_expires_at: existing.expires_at,

          subscription_start: existing.started_at,

          subscription_end: existing.expires_at,

          already_processed: true,
        },
      );
    }

    const { data: updatedShop, error: shopError } = await supabase

      .from("shops")

      .update({
        status: "active",

        plan_id: claimed.plan_id,

        plan_expires_at: claimed.expires_at,

        subscription_status: "active",

        subscription_start: claimed.started_at,

        subscription_end: claimed.expires_at,

        updated_at: new Date().toISOString(),
      })

      .eq("shop_id", shopId)

      .select(
        "shop_id,status,plan_id,plan_expires_at,subscription_status,subscription_start,subscription_end",
      )

      .single();

    if (shopError) throw shopError;

    return ok(
      res,

      "Payment verified successfully. Your Quick2Print subscription is now active.",

      {
        subscription_id: claimed.subscription_id,

        payment_status: "PAID",

        payment_id: paymentId,

        payment_method: paymentMethod,

        shop: updatedShop,
      },
    );
  } catch (e) {
    console.error("[VERIFY SUBSCRIPTION]", e);

    return fail(
      res,

      e.message || "We couldn't verify your payment. Please try again.",

      "SUBSCRIPTION_VERIFY_FAILED",

      500,
    );
  }
});

app.get("/health", (req, res) =>
  ok(res, "Quick2Print Subscription Server is running.", {
    environment: CASHFREE_ENV,

    service: "subscription-payment",

    timestamp: new Date().toISOString(),
  }),
);

app.use((req, res) =>
  fail(
    res,

    "The requested API endpoint was not found.",

    "ENDPOINT_NOT_FOUND",

    404,
  ),
);

app.listen(PORT, () => {
  console.log(
    `Quick2Print Subscription Server running on port ${PORT} (${CASHFREE_ENV})`,
  );
});
