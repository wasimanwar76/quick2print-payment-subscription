require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

const app = express();

// ==========================================
// MIDDLEWARE
// ==========================================

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

app.use(express.json({ limit: "1mb" }));

// ==========================================
// SUPABASE CONFIG
// ==========================================

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error("SUPABASE_URL and SUPABASE_KEY are required.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Status used for print_jobs that are uploaded but not yet paid.
// The print agent must ONLY pick up jobs with status "pending".
// If print_jobs.status has a CHECK constraint / enum, add this value to it.
const JOB_STATUS_AWAITING_PAYMENT = "awaiting_payment";
const JOB_STATUS_READY = "pending";

const ALLOWED_COLOR_TYPES = ["BW", "Color"];
const ALLOWED_PAPER_SIZES = ["A4", "A3", "Letter"];
const MAX_FILES_PER_ORDER = 20;
const MAX_COPIES = 50;

// ==========================================
// CASHFREE CONFIG HELPER
// Gets credentials from shops table
// ==========================================

async function getShopCashfreeConfig(shopId) {
  if (!shopId) {
    throw new Error("Shop ID is required.");
  }

  const { data: shop, error } = await supabase
    .from("shops")
    .select(
      `
      shop_id,
      shop_name,
      status,
      print_price,
      color_price,
      whatsapp_number,
      cashfree_app_id,
      cashfree_secret_key,
      cashfree_env
    `,
    )
    .eq("shop_id", shopId)
    .single();

  if (error) {
    throw new Error(`Failed to get shop configuration: ${error.message}`);
  }

  if (!shop) {
    throw new Error("Shop not found.");
  }

  if (shop.status !== "active") {
    throw new Error("Shop is not active.");
  }

  if (!shop.cashfree_app_id) {
    throw new Error("Cashfree App ID is not configured for this shop.");
  }

  if (!shop.cashfree_secret_key) {
    throw new Error("Cashfree Secret Key is not configured for this shop.");
  }

  const environment = String(shop.cashfree_env || "SANDBOX").toUpperCase();

  if (!["SANDBOX", "PRODUCTION"].includes(environment)) {
    throw new Error("Invalid Cashfree environment. Use SANDBOX or PRODUCTION.");
  }

  const apiUrl =
    environment === "PRODUCTION"
      ? "https://api.cashfree.com/pg"
      : "https://sandbox.cashfree.com/pg";

  const headers = {
    "Content-Type": "application/json",
    "x-client-id": shop.TEST107918248d19ef74e6e8b10f3aa042819701,
    "x-client-secret": shop.cashfree_secret_key,
    "x-api-version": "2022-09-01",
  };

  return {
    shop,
    environment,
    apiUrl,
    headers,
  };
}

// ==========================================
// HELPER: validate files sent by the browser
// ==========================================

function validateAndNormalizeFiles(files, shopId) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("At least one uploaded file is required.");
  }

  if (files.length > MAX_FILES_PER_ORDER) {
    throw new Error(`Too many files. Maximum is ${MAX_FILES_PER_ORDER}.`);
  }

  return files.map((f, i) => {
    const storagePath = String(f?.storage_path || "");

    // Files must live under this shop's folder. This stops a client
    // from attaching another shop's / someone else's file to an order.
    if (!storagePath.startsWith(`shop/${shopId}/job/`)) {
      throw new Error(`File ${i + 1} has an invalid storage path.`);
    }

    const pages = Math.floor(Number(f.page_count));
    const copies = Math.floor(Number(f.copies));

    if (!Number.isFinite(pages) || pages < 1 || pages > 5000) {
      throw new Error(`File ${i + 1} has an invalid page count.`);
    }

    if (!Number.isFinite(copies) || copies < 1 || copies > MAX_COPIES) {
      throw new Error(`File ${i + 1} has an invalid copy count.`);
    }

    return {
      original_filename: String(f.original_filename || "document").slice(
        0,
        255,
      ),
      storage_path: storagePath,
      mime_type: String(f.mime_type || "application/octet-stream"),
      file_size: Math.max(0, Number(f.file_size) || 0),
      page_count: pages,
      copies,
    };
  });
}

// ==========================================
// API 1: CREATE PAYMENT
//
// Browser uploads files to storage FIRST, then calls this.
// This creates: print_orders row + print_jobs rows (awaiting_payment)
// + Cashfree order. Jobs are released to the print agent only
// when /verify confirms PAID.
// ==========================================

app.post("/api/payment/create", async (req, res) => {
  let createdOrderId = null;

  try {
    const { shopId, customerPhone, customerName, files, colorType, paperSize } =
      req.body;

    // --------------------------------------
    // VALIDATION
    // --------------------------------------

    if (!shopId) {
      return res.status(400).json({
        success: false,
        message: "shopId is required.",
      });
    }

    if (!ALLOWED_COLOR_TYPES.includes(colorType)) {
      return res.status(400).json({
        success: false,
        message: "Invalid print type.",
      });
    }

    if (!ALLOWED_PAPER_SIZES.includes(paperSize)) {
      return res.status(400).json({
        success: false,
        message: "Invalid paper size.",
      });
    }

    let normalizedFiles;

    try {
      normalizedFiles = validateAndNormalizeFiles(files, shopId);
    } catch (validationError) {
      return res.status(400).json({
        success: false,
        message: validationError.message,
      });
    }

    // --------------------------------------
    // GET SHOP CASHFREE CONFIG
    // --------------------------------------

    const { shop, environment, apiUrl, headers } =
      await getShopCashfreeConfig(shopId);

    // --------------------------------------
    // COMPUTE AMOUNT ON THE SERVER
    // Never trust the amount sent by the browser.
    // --------------------------------------

    const priceColumn = colorType === "Color" ? "color_price" : "print_price";

    const pricePerPage = Number(shop[priceColumn]);

    if (!Number.isFinite(pricePerPage) || pricePerPage <= 0) {
      return res.status(400).json({
        success: false,
        code: "PRICE_NOT_CONFIGURED",
        message:
          colorType === "Color"
            ? "This shop has not set a color print price."
            : "This shop has not set a black print price.",
      });
    }

    const totalFiles = normalizedFiles.length;

    const totalPages = normalizedFiles.reduce(
      (sum, f) => sum + f.page_count * f.copies,
      0,
    );

    const amount = Math.round(totalPages * pricePerPage * 100) / 100;

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Valid payment amount is required.",
      });
    }

    // --------------------------------------
    // CREATE LOCAL PRINT ORDER
    // --------------------------------------

    const { data: printOrder, error: orderError } = await supabase
      .from("print_orders")
      .insert({
        shop_id: shopId,
        total_files: totalFiles,
        total_pages: totalPages,
        amount_charged: amount,
        payment_mode: "UPI",
        status: "pending",
        payment_status: "PENDING",
        payment_amount: amount,
        payment_currency: "INR",
      })
      .select("order_id")
      .single();

    if (orderError) {
      throw new Error(`Failed to create print order: ${orderError.message}`);
    }

    const orderId = printOrder.order_id;
    createdOrderId = orderId;

    // --------------------------------------
    // CREATE PRINT JOBS (NOT YET PRINTABLE)
    // --------------------------------------

    const jobsPayload = normalizedFiles.map((f) => ({
      order_id: orderId,
      shop_id: shopId,
      original_filename: f.original_filename,
      storage_path: f.storage_path,
      mime_type: f.mime_type,
      file_size: f.file_size,
      page_count: f.page_count,
      copies: f.copies,
      color_type: colorType,
      paper_size: paperSize,
      status: JOB_STATUS_AWAITING_PAYMENT,
    }));

    const { error: jobsError } = await supabase
      .from("print_jobs")
      .insert(jobsPayload);

    if (jobsError) {
      throw new Error(`Failed to create print jobs: ${jobsError.message}`);
    }

    // --------------------------------------
    // CASHFREE ORDER
    // --------------------------------------

    const cashfreeOrderId = `Q2P_${shopId}_${orderId.replace(/-/g, "")}`;

    const payload = {
      order_amount: amount,
      order_currency: "INR",
      order_id: cashfreeOrderId,
      customer_details: {
        customer_id: `CUST_${shopId}_${Date.now()}`,
        customer_phone: customerPhone || shop.whatsapp_number,
        customer_name: customerName || "Quick2Print Customer",
      },
      order_meta: {
        return_url:
          `https://www.quick2print.in/payment-status.html` +
          `?order_id=${encodeURIComponent(orderId)}` +
          `&shop_id=${encodeURIComponent(shopId)}`,
      },
    };

    console.log("Creating Cashfree order...");
    console.log("Shop:", shopId);
    console.log("Environment:", environment);
    console.log("Amount:", amount);

    const cfResponse = await axios.post(`${apiUrl}/orders`, payload, {
      headers,
    });

    const paymentSessionId = cfResponse.data?.payment_session_id;

    if (!paymentSessionId) {
      throw new Error("Cashfree did not return payment_session_id.");
    }

    // --------------------------------------
    // UPDATE PRINT ORDER
    // --------------------------------------

    const { error: updateError } = await supabase
      .from("print_orders")
      .update({
        payment_order_id: cashfreeOrderId,
        payment_session_id: paymentSessionId,
        payment_status: "PENDING",
        payment_amount: amount,
        payment_currency: "INR",
      })
      .eq("order_id", orderId);

    if (updateError) {
      console.error("Print order update error:", updateError);
      throw new Error("Payment created but database update failed.");
    }

    return res.status(200).json({
      success: true,
      order_id: orderId,
      payment_order_id: cashfreeOrderId,
      payment_session_id: paymentSessionId,
      amount: amount,
      total_files: totalFiles,
      total_pages: totalPages,
      currency: "INR",
      payment_status: "PENDING",
      environment: environment,
      shop_id: shopId,
    });
  } catch (error) {
    console.error(
      "Create Payment Error:",
      error.response?.data || error.message,
    );

    // Don't leave a half-created order that looks payable.
    if (createdOrderId) {
      await supabase
        .from("print_orders")
        .update({
          payment_status: "FAILED",
          status: "cancelled",
          payment_error_message: String(
            error.response?.data?.message || error.message || "Create failed",
          ),
        })
        .eq("order_id", createdOrderId);
    }

    return res.status(500).json({
      success: false,
      message:
        error.response?.data?.message ||
        error.message ||
        "Payment creation failed.",
    });
  }
});

// ==========================================
// API 2: VERIFY PAYMENT
//
// On PAID: releases the order's print_jobs to the print agent
// (awaiting_payment -> pending). Safe to call repeatedly.
// ==========================================

app.post("/api/payment/verify", async (req, res) => {
  try {
    const { orderId, shopId } = req.body;

    if (!orderId) {
      return res.status(400).json({
        success: false,
        message: "orderId is required.",
      });
    }

    if (!shopId) {
      return res.status(400).json({
        success: false,
        message: "shopId is required.",
      });
    }

    console.log(`Verifying order: ${orderId}`);

    const { apiUrl, headers, environment } =
      await getShopCashfreeConfig(shopId);

    // --------------------------------------
    // GET LOCAL PRINT ORDER
    // --------------------------------------

    const { data: localOrder, error: localOrderError } = await supabase
      .from("print_orders")
      .select(
        `
        order_id,
        shop_id,
        total_files,
        total_pages,
        payment_order_id,
        payment_status,
        payment_amount
      `,
      )
      .eq("order_id", orderId)
      .eq("shop_id", shopId)
      .single();

    if (localOrderError || !localOrder) {
      return res.status(404).json({
        success: false,
        message: "Print order not found.",
      });
    }

    if (!localOrder.payment_order_id) {
      return res.status(400).json({
        success: false,
        message: "Cashfree payment order ID not found.",
      });
    }

    // --------------------------------------
    // GET CASHFREE ORDER STATUS
    // --------------------------------------

    const response = await axios.get(
      `${apiUrl}/orders/${encodeURIComponent(localOrder.payment_order_id)}`,
      { headers },
    );

    const cashfreeOrder = response.data;

    const cashfreeStatus = String(
      cashfreeOrder?.order_status || "",
    ).toUpperCase();

    console.log("Cashfree status:", cashfreeStatus);

    // Extra safety: the amount Cashfree collected must match our order.
    if (
      cashfreeStatus === "PAID" &&
      Math.abs(
        Number(cashfreeOrder?.order_amount) - Number(localOrder.payment_amount),
      ) > 0.01
    ) {
      console.error("Amount mismatch", {
        cashfree: cashfreeOrder?.order_amount,
        local: localOrder.payment_amount,
      });

      return res.status(409).json({
        success: false,
        message: "Payment amount mismatch. Please contact the shopkeeper.",
      });
    }

    // --------------------------------------
    // GET PAYMENT DETAILS
    // --------------------------------------

    let paymentData = null;

    try {
      const paymentResponse = await axios.get(
        `${apiUrl}/orders/${encodeURIComponent(
          localOrder.payment_order_id,
        )}/payments`,
        { headers },
      );

      const payments = Array.isArray(paymentResponse.data)
        ? paymentResponse.data
        : [];

      if (payments.length > 0) {
        paymentData =
          payments.find(
            (payment) =>
              String(payment.payment_status || "").toUpperCase() === "SUCCESS",
          ) || payments[payments.length - 1];
      }
    } catch (paymentError) {
      console.warn(
        "Could not fetch payment details:",
        paymentError.response?.data || paymentError.message,
      );
    }

    // --------------------------------------
    // MAP CASHFREE STATUS
    // --------------------------------------

    let dbStatus = "PENDING";

    if (cashfreeStatus === "PAID") {
      dbStatus = "PAID";
    } else if (cashfreeStatus === "EXPIRED") {
      dbStatus = "EXPIRED";
    } else if (cashfreeStatus === "FAILED") {
      dbStatus = "FAILED";
    }

    const cfPaymentId = paymentData?.cf_payment_id
      ? String(paymentData.cf_payment_id)
      : null;

    const paymentMethod = paymentData?.payment_method
      ? typeof paymentData.payment_method === "string"
        ? paymentData.payment_method
        : JSON.stringify(paymentData.payment_method)
      : null;

    const transactionReference =
      paymentData?.bank_reference ||
      paymentData?.payment_group ||
      paymentData?.cf_payment_id ||
      null;

    let paymentCompletedAt = null;

    if (dbStatus === "PAID") {
      paymentCompletedAt =
        paymentData?.payment_completion_time ||
        paymentData?.payment_time ||
        new Date().toISOString();
    }

    let paymentErrorMessage = null;

    if (dbStatus === "FAILED") {
      paymentErrorMessage =
        paymentData?.payment_message ||
        paymentData?.error_details ||
        cashfreeOrder?.order_tags?.error ||
        "Payment failed.";
    }

    if (dbStatus === "EXPIRED") {
      paymentErrorMessage = "Payment order expired.";
    }

    // --------------------------------------
    // UPDATE PRINT ORDER
    // --------------------------------------

    const updateData = {
      payment_status: dbStatus,
      payment_verified_at: new Date().toISOString(),
    };

    if (cfPaymentId) updateData.cf_payment_id = cfPaymentId;
    if (paymentMethod) updateData.payment_method = paymentMethod;
    if (transactionReference) {
      updateData.transaction_reference = String(transactionReference);
    }
    if (paymentCompletedAt)
      updateData.payment_completed_at = paymentCompletedAt;

    if (paymentErrorMessage) {
      updateData.payment_error_message = String(paymentErrorMessage);
    } else if (dbStatus === "PAID") {
      updateData.payment_error_message = null;
    }

    // Move order to "processing" in the same update when paid.
    if (dbStatus === "PAID") {
      updateData.status = "processing";
    }

    const { data: updatedOrder, error: updateError } = await supabase
      .from("print_orders")
      .update(updateData)
      .eq("order_id", orderId)
      .eq("shop_id", shopId)
      .select(
        `
        order_id,
        shop_id,
        total_files,
        total_pages,
        payment_order_id,
        payment_status,
        payment_session_id,
        cf_payment_id,
        payment_amount,
        payment_currency,
        payment_method,
        payment_completed_at,
        payment_verified_at,
        transaction_reference,
        payment_error_message
      `,
      )
      .single();

    if (updateError) {
      console.error("Supabase Verify Update Error:", updateError);
      throw new Error("Failed to update payment information.");
    }

    // --------------------------------------
    // IF PAID: RELEASE PRINT JOBS TO THE PRINT AGENT
    // Idempotent: only rows still awaiting payment are touched.
    // --------------------------------------

    let jobsReleased = 0;
    let jobsTotal = 0;

    if (dbStatus === "PAID") {
      const { data: released, error: releaseError } = await supabase
        .from("print_jobs")
        .update({ status: JOB_STATUS_READY })
        .eq("order_id", orderId)
        .eq("shop_id", shopId)
        .eq("status", JOB_STATUS_AWAITING_PAYMENT)
        .select("job_id");

      if (releaseError) {
        console.error("Failed to release print jobs:", releaseError);
        throw new Error(
          "Payment received but print jobs could not be started.",
        );
      }

      jobsReleased = released?.length || 0;

      const { count } = await supabase
        .from("print_jobs")
        .select("job_id", { count: "exact", head: true })
        .eq("order_id", orderId);

      jobsTotal = count || 0;

      if (jobsTotal === 0) {
        console.error(`PAID order ${orderId} has no print_jobs rows!`);
      }
    }

    return res.status(200).json({
      success: true,
      order_id: orderId,
      shop_id: shopId,
      payment_order_id: localOrder.payment_order_id,
      payment_status: dbStatus,
      cashfree_status: cashfreeStatus,
      payment_session_id: updatedOrder.payment_session_id,
      cf_payment_id: updatedOrder.cf_payment_id,
      payment_amount: updatedOrder.payment_amount,
      payment_method: updatedOrder.payment_method,
      transaction_reference: updatedOrder.transaction_reference,
      payment_completed_at: updatedOrder.payment_completed_at,
      payment_verified_at: updatedOrder.payment_verified_at,
      payment_error_message: updatedOrder.payment_error_message,
      total_files: updatedOrder.total_files,
      total_pages: updatedOrder.total_pages,
      jobs_released: jobsReleased,
      jobs_total: jobsTotal,
      environment: environment,
    });
  } catch (error) {
    console.error(
      "Verify Payment Error:",
      error.response?.data || error.message,
    );

    return res.status(500).json({
      success: false,
      message:
        error.response?.data?.message ||
        error.message ||
        "Payment verification failed.",
    });
  }
});

// ==========================================
// API 3: GET PAYMENT ORDER
// ==========================================

app.get("/api/payment/order/:orderId", async (req, res) => {
  try {
    const { orderId } = req.params;
    const { shopId } = req.query;

    if (!shopId) {
      return res.status(400).json({
        success: false,
        message: "shopId is required.",
      });
    }

    const { data, error } = await supabase
      .from("print_orders")
      .select(
        `
          order_id,
          shop_id,
          total_files,
          total_pages,
          amount_charged,
          payment_mode,
          status,
          created_at,
          completed_at,
          payment_status,
          payment_order_id,
          payment_session_id,
          cf_payment_id,
          payment_amount,
          payment_currency,
          payment_method,
          payment_completed_at,
          payment_verified_at,
          transaction_reference,
          payment_error_message
        `,
      )
      .eq("order_id", orderId)
      .eq("shop_id", shopId)
      .single();

    if (error || !data) {
      return res.status(404).json({
        success: false,
        message: "Payment order not found.",
      });
    }

    return res.status(200).json({
      success: true,
      order: data,
    });
  } catch (error) {
    console.error("Get Payment Order Error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Failed to get payment order.",
    });
  }
});


// ==========================================
// SUBSCRIPTION PAYMENT HELPERS
// Uses public.shop_subscriptions and public.shops schemas.
// Keep these endpoints on the same backend used by the dashboard.
// ==========================================

async function getSubscriptionShop(shopId) {
  if (!shopId) throw new Error("Shop ID is required.");

  const { data: shop, error } = await supabase
    .from("shops")
    .select(`
      shop_id,
      shop_name,
      owner_name,
      whatsapp_number,
      email,
      status,
      plan_id,
      subscription_status,
      cashfree_app_id,
      cashfree_secret_key,
      cashfree_env
    `)
    .eq("shop_id", shopId)
    .maybeSingle();

  if (error) throw new Error(`Failed to load shop: ${error.message}`);
  if (!shop) throw new Error("Shop not found.");
  if (shop.status !== "active") throw new Error("This shop is not active.");

  if (!shop.cashfree_app_id || !shop.cashfree_secret_key) {
    throw new Error("Cashfree App ID or Secret Key is missing in public.shops.");
  }

  const environment = String(shop.cashfree_env || "SANDBOX").toUpperCase();
  if (!["SANDBOX", "PRODUCTION"].includes(environment)) {
    throw new Error("Invalid cashfree_env. Use SANDBOX or PRODUCTION.");
  }

  return {
    shop,
    environment,
    apiUrl:
      environment === "PRODUCTION"
        ? "https://api.cashfree.com/pg"
        : "https://sandbox.cashfree.com/pg",
    headers: {
      "Content-Type": "application/json",
      "x-client-id": shop.cashfree_app_id,
      "x-client-secret": shop.cashfree_secret_key,
      "x-api-version": "2023-08-01",
    },
  };
}

function subscriptionReturnUrl(subscriptionId, shopId) {
  const url = new URL("https://www.quick2print.in/subscription-payment-success.html");
  url.searchParams.set("subscription_id", subscriptionId);
  url.searchParams.set("shop_id", shopId);
  return url.toString();
}

function addMonths(date, months) {
  const result = new Date(date);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)
  ).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

// ==========================================
// SUBSCRIPTION API 1: CREATE SUBSCRIPTION + CASHFREE ORDER
// POST /api/subscription/create { shopId, planId }
// ==========================================

app.post("/api/subscription/create", async (req, res) => {
  let insertedSubscriptionId = null;

  try {
    const shopId = String(req.body?.shopId || req.body?.shop_id || "").trim();
    const planId = String(req.body?.planId || req.body?.plan_id || "").trim();

    if (!shopId || !planId) {
      return res.status(400).json({
        success: false,
        message: "shopId and planId are required.",
      });
    }

    const { shop, environment, apiUrl, headers } =
      await getSubscriptionShop(shopId);

    const { data: plan, error: planError } = await supabase
      .from("plans")
      .select("plan_id, name, price_inr, duration_months")
      .eq("plan_id", planId)
      .maybeSingle();

    if (planError) {
      throw new Error(`Failed to load plan: ${planError.message}`);
    }
    if (!plan) throw new Error("Selected plan was not found.");

    const amount = Number(plan.price_inr);
    const durationMonths = Number(plan.duration_months);

    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error("Selected plan must have a valid price_inr greater than zero.");
    }
    if (!Number.isInteger(durationMonths) || durationMonths < 1) {
      throw new Error("Selected plan must have a valid duration_months value.");
    }

    // Insert first so the subscription UUID can be included in Cashfree's return URL.
    const { data: subscriptionRow, error: insertError } = await supabase
      .from("shop_subscriptions")
      .insert({
        shop_id: shopId,
        plan_id: plan.plan_id,
        amount: amount.toFixed(2),
        currency: "INR",
        duration_months: durationMonths,
        payment_status: "PENDING",
        payment_environment: environment,
        started_at: null,
        expires_at: null,
      })
      .select("subscription_id, shop_id, plan_id, amount, duration_months, payment_status, payment_environment, created_at")
      .single();

    if (insertError) {
      throw new Error(`Failed to insert shop_subscriptions row: ${insertError.message}`);
    }

    insertedSubscriptionId = subscriptionRow.subscription_id;

    const cashfreeOrderId =
      `Q2PSUB_${String(insertedSubscriptionId).replace(/-/g, "")}`;

    const phone = String(shop.whatsapp_number || "").replace(/\D/g, "");
    if (phone.length < 10) {
      throw new Error("Shop WhatsApp number must contain at least 10 digits for Cashfree.");
    }

    const customerId =
      `Q2P${String(shop.shop_id).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 35)}`;

    const payload = {
      order_id: cashfreeOrderId,
      order_amount: Number(amount.toFixed(2)),
      order_currency: "INR",
      customer_details: {
        customer_id: customerId,
        customer_name: String(shop.owner_name || shop.shop_name || "Quick2Print Shop").slice(0, 100),
        customer_email: shop.email || "support@quick2print.in",
        customer_phone: phone.slice(-10),
      },
      order_meta: {
        return_url: subscriptionReturnUrl(insertedSubscriptionId, shopId),
      },
      order_note: `Quick2Print subscription: ${String(plan.name || plan.plan_id).slice(0, 200)}`,
    };

    let cashfreeResponse;
    try {
      cashfreeResponse = await axios.post(`${apiUrl}/orders`, payload, {
        headers,
        timeout: 20000,
      });
    } catch (cashfreeError) {
      const detail =
        cashfreeError.response?.data?.message ||
        cashfreeError.response?.data?.message_code ||
        cashfreeError.response?.data?.type ||
        cashfreeError.message;
      throw new Error(`Cashfree order creation failed: ${detail}`);
    }

    const cashfreeOrder = cashfreeResponse.data || {};
    if (!cashfreeOrder.payment_session_id || !cashfreeOrder.order_id) {
      throw new Error("Cashfree response did not include order_id and payment_session_id.");
    }

    const { error: updateError } = await supabase
      .from("shop_subscriptions")
      .update({
        cashfree_order_id: cashfreeOrder.order_id,
        cashfree_payment_session_id: cashfreeOrder.payment_session_id,
        payment_status: "PENDING",
        payment_environment: environment,
        payment_error_message: null,
        updated_at: new Date().toISOString(),
      })
      .eq("subscription_id", insertedSubscriptionId)
      .eq("shop_id", shopId);

    if (updateError) {
      throw new Error(`Cashfree order was created, but subscription update failed: ${updateError.message}`);
    }

    console.log("[Q2P subscription] Cashfree order created", {
      shopId,
      planId,
      subscriptionId: insertedSubscriptionId,
      cashfreeOrderId: cashfreeOrder.order_id,
      environment,
    });

    return res.status(201).json({
      success: true,
      message: "Subscription payment created.",
      data: {
        ...subscriptionRow,
        cashfree_order_id: cashfreeOrder.order_id,
        cashfree_payment_session_id: cashfreeOrder.payment_session_id,
        payment_environment: environment,
        plan_name: plan.name,
        shop_name: shop.shop_name,
      },
    });
  } catch (error) {
    console.error("[Q2P subscription] Create failed:", error.response?.data || error.message);

    // Keep a traceable failed row instead of leaving it looking payable.
    if (insertedSubscriptionId) {
      const { error: statusError } = await supabase
        .from("shop_subscriptions")
        .update({
          payment_status: "FAILED",
          payment_error_message: String(error.message || "Subscription creation failed.").slice(0, 1000),
          updated_at: new Date().toISOString(),
        })
        .eq("subscription_id", insertedSubscriptionId);

      if (statusError) {
        console.error("[Q2P subscription] Could not save creation error:", statusError.message);
      }
    }

    return res.status(400).json({
      success: false,
      message: error.message || "Unable to create subscription payment.",
    });
  }
});

// ==========================================
// SUBSCRIPTION API 2: GET SUBSCRIPTION FOR CHECKOUT / RECEIPT
// GET /api/subscription/:subscriptionId?shop_id=...
// ==========================================

app.get("/api/subscription/:subscriptionId", async (req, res) => {
  try {
    const subscriptionId = String(req.params.subscriptionId || "").trim();
    const shopId = String(req.query.shop_id || req.query.shopId || "").trim();

    if (!subscriptionId) {
      return res.status(400).json({ success: false, message: "Subscription ID is required." });
    }

    let query = supabase
      .from("shop_subscriptions")
      .select(`
        subscription_id,
        shop_id,
        plan_id,
        amount,
        currency,
        duration_months,
        cashfree_order_id,
        cashfree_payment_session_id,
        cashfree_payment_id,
        payment_status,
        payment_method,
        payment_environment,
        payment_error_message,
        created_at,
        updated_at,
        started_at,
        expires_at
      `)
      .eq("subscription_id", subscriptionId);

    if (shopId) query = query.eq("shop_id", shopId);

    const { data: subscriptionRow, error } = await query.maybeSingle();
    if (error) throw new Error(`Failed to load subscription: ${error.message}`);
    if (!subscriptionRow) {
      return res.status(404).json({ success: false, message: "Subscription not found for this shop." });
    }

    const [{ data: shop, error: shopError }, { data: plan, error: planError }] =
      await Promise.all([
        supabase
          .from("shops")
          .select("shop_id, shop_name, status, plan_id, subscription_status, plan_expires_at, subscription_start, subscription_end")
          .eq("shop_id", subscriptionRow.shop_id)
          .maybeSingle(),
        supabase
          .from("plans")
          .select("plan_id, name, price_inr, duration_months")
          .eq("plan_id", subscriptionRow.plan_id)
          .maybeSingle(),
      ]);

    if (shopError) throw new Error(`Failed to load shop details: ${shopError.message}`);
    if (planError) throw new Error(`Failed to load plan details: ${planError.message}`);

    return res.json({
      success: true,
      data: {
        ...subscriptionRow,
        shop_name: shop?.shop_name || null,
        shop_status: shop?.status || null,
        shop_plan_id: shop?.plan_id || null,
        subscription_status: shop?.subscription_status || null,
        plan_expires_at: shop?.plan_expires_at || null,
        subscription_start: shop?.subscription_start || null,
        subscription_end: shop?.subscription_end || null,
        plan_name: plan?.name || subscriptionRow.plan_id,
        plan_price_inr: plan?.price_inr ?? subscriptionRow.amount,
      },
    });
  } catch (error) {
    console.error("[Q2P subscription] Load failed:", error.message);
    return res.status(500).json({
      success: false,
      message: error.message || "Unable to load subscription.",
    });
  }
});

// ==========================================
// SUBSCRIPTION API 3: VERIFY CASHFREE PAYMENT
// POST /api/subscription/verify { subscriptionId, shopId }
// Only Cashfree's server response can activate a subscription.
// ==========================================

app.post("/api/subscription/verify", async (req, res) => {
  try {
    const subscriptionId = String(req.body?.subscriptionId || req.body?.subscription_id || "").trim();
    const shopId = String(req.body?.shopId || req.body?.shop_id || "").trim();

    if (!subscriptionId || !shopId) {
      return res.status(400).json({
        success: false,
        message: "subscriptionId and shopId are required.",
      });
    }

    const { data: subscriptionRow, error: subscriptionError } = await supabase
      .from("shop_subscriptions")
      .select(`
        subscription_id, shop_id, plan_id, amount, currency, duration_months,
        cashfree_order_id, cashfree_payment_id, payment_status,
        payment_environment, started_at, expires_at
      `)
      .eq("subscription_id", subscriptionId)
      .eq("shop_id", shopId)
      .maybeSingle();

    if (subscriptionError) throw new Error(`Failed to load subscription: ${subscriptionError.message}`);
    if (!subscriptionRow) {
      return res.status(404).json({ success: false, message: "Subscription not found for this shop." });
    }

    if (String(subscriptionRow.payment_status).toUpperCase() === "PAID") {
      return res.json({ success: true, message: "Subscription is already paid.", data: subscriptionRow });
    }

    if (!subscriptionRow.cashfree_order_id) {
      return res.status(409).json({
        success: false,
        message: "Cashfree order ID is missing. The subscription order was not created successfully.",
        data: subscriptionRow,
      });
    }

    const { apiUrl, headers } = await getSubscriptionShop(shopId);

    let cashfreeOrderResponse;
    try {
      cashfreeOrderResponse = await axios.get(
        `${apiUrl}/orders/${encodeURIComponent(subscriptionRow.cashfree_order_id)}`,
        { headers, timeout: 20000 }
      );
    } catch (cashfreeError) {
      const detail =
        cashfreeError.response?.data?.message ||
        cashfreeError.response?.data?.message_code ||
        cashfreeError.message;
      throw new Error(`Cashfree verification request failed: ${detail}`);
    }

    const cashfreeOrder = cashfreeOrderResponse.data || {};
    const cashfreeStatus = String(cashfreeOrder.order_status || "").toUpperCase();
    const cashfreeAmount = Number(cashfreeOrder.order_amount);
    const expectedAmount = Number(subscriptionRow.amount);

    if (cashfreeStatus === "PAID" &&
        (!Number.isFinite(cashfreeAmount) || Math.abs(cashfreeAmount - expectedAmount) > 0.009)) {
      return res.status(409).json({
        success: false,
        message: "Cashfree amount does not match the subscription amount. Contact support.",
        error: { code: "PAYMENT_AMOUNT_MISMATCH" },
      });
    }

    let paymentData = null;
    if (cashfreeStatus === "PAID") {
      try {
        const paymentResponse = await axios.get(
          `${apiUrl}/orders/${encodeURIComponent(subscriptionRow.cashfree_order_id)}/payments`,
          { headers, timeout: 20000 }
        );
        const payments = Array.isArray(paymentResponse.data) ? paymentResponse.data : [];
        paymentData =
          payments.find((p) => String(p.payment_status || "").toUpperCase() === "SUCCESS") ||
          payments[payments.length - 1] ||
          null;
      } catch (paymentError) {
        // Order status + amount are verified directly with Cashfree; payment detail is optional.
        console.warn("[Q2P subscription] Could not fetch payment detail:", paymentError.response?.data || paymentError.message);
      }
    }

    if (cashfreeStatus !== "PAID") {
      const mappedStatus =
        cashfreeStatus === "EXPIRED" ? "EXPIRED" :
        cashfreeStatus === "FAILED" ? "FAILED" : "PENDING";

      const updateData = {
        payment_status: mappedStatus,
        updated_at: new Date().toISOString(),
      };
      if (mappedStatus === "FAILED") {
        updateData.payment_error_message =
          String(cashfreeOrder.order_status || "Payment failed").slice(0, 1000);
      }

      const { data: updated, error: updateError } = await supabase
        .from("shop_subscriptions")
        .update(updateData)
        .eq("subscription_id", subscriptionId)
        .eq("shop_id", shopId)
        .select("subscription_id, shop_id, plan_id, amount, currency, duration_months, cashfree_order_id, cashfree_payment_id, payment_status, payment_environment, started_at, expires_at")
        .single();

      if (updateError) throw new Error(`Failed to save payment status: ${updateError.message}`);

      return res.json({
        success: true,
        message: `Cashfree payment status: ${mappedStatus}.`,
        data: updated,
      });
    }

    const now = new Date();
    const expiresAt = addMonths(now, Number(subscriptionRow.duration_months));
    const paymentId = paymentData?.cf_payment_id != null
      ? String(paymentData.cf_payment_id)
      : subscriptionRow.cashfree_payment_id || null;

    const paymentMethod = paymentData?.payment_method
      ? (typeof paymentData.payment_method === "string"
          ? paymentData.payment_method
          : JSON.stringify(paymentData.payment_method))
      : null;

    // Mark subscription paid first. Do not activate the shop if this DB update fails.
    const { data: paidSubscription, error: paidError } = await supabase
      .from("shop_subscriptions")
      .update({
        payment_status: "PAID",
        cashfree_payment_id: paymentId,
        started_at: now.toISOString(),
        expires_at: expiresAt.toISOString(),
        payment_method: paymentMethod,
        payment_error_message: null,
        updated_at: now.toISOString(),
      })
      .eq("subscription_id", subscriptionId)
      .eq("shop_id", shopId)
      .select("subscription_id, shop_id, plan_id, amount, currency, duration_months, cashfree_order_id, cashfree_payment_session_id, cashfree_payment_id, payment_status, payment_environment, payment_method, payment_error_message, created_at, updated_at, started_at, expires_at")
      .single();

    if (paidError) throw new Error(`Cashfree confirmed payment, but saving subscription failed: ${paidError.message}`);

    // Activate the shop only after the successful payment is saved.
    const { error: shopUpdateError } = await supabase
      .from("shops")
      .update({
        plan_id: subscriptionRow.plan_id,
        plan_expires_at: expiresAt.toISOString(),
        subscription_status: "active",
        subscription_start: now.toISOString(),
        subscription_end: expiresAt.toISOString(),
        updated_at: now.toISOString(),
      })
      .eq("shop_id", shopId);

    if (shopUpdateError) {
      console.error("[Q2P subscription] Payment is PAID but shop activation update failed:", shopUpdateError.message);
      return res.status(500).json({
        success: false,
        message: "Payment was confirmed and saved, but shop activation failed. Contact support; do not pay again.",
        data: paidSubscription,
      });
    }

    console.log("[Q2P subscription] Payment verified and shop activated", {
      shopId,
      subscriptionId,
      cashfreeOrderId: subscriptionRow.cashfree_order_id,
      paymentId,
      expiresAt: expiresAt.toISOString(),
    });

    return res.json({
      success: true,
      message: "Payment verified and subscription activated.",
      data: paidSubscription,
    });
  } catch (error) {
    console.error("[Q2P subscription] Verification failed:", error.response?.data || error.message);
    return res.status(500).json({
      success: false,
      message: error.message || "Payment verification failed.",
    });
  }
});


// ==========================================
// API 4: HEALTH CHECK
// ==========================================

app.get("/api/health", (req, res) => {
  res.status(200).json({
    success: true,
    message: "Quick2Print Payment Server is running.",
    time: new Date().toISOString(),
  });
});

app.get("/", (req, res) => {
  res.send("API is working!");
});

// ==========================================
// START SERVER
// ==========================================

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Quick2Print Payment Server running on port ${PORT}`);
});

module.exports = app;
