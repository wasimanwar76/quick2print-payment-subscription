# Quick2Print Subscription Payment Server

Professional Cashfree + Supabase subscription payment server.

## Frontend create request

POST /api/subscription/create

```json
{
  "shopId": "SHOP001",
  "planName": "Smart"
}
```

The frontend does NOT send price or duration. The server reads both from `plans`.

## Frontend verify request

POST /api/subscription/verify

```json
{
  "subscriptionId": "UUID_FROM_CREATE_RESPONSE",
  "shopId": "SHOP001"
}
```

## Successful verification updates shops

- status = active
- plan_id = selected plan
- plan_expires_at = calculated expiry
- subscription_status = active
- subscription_start = payment activation time
- subscription_end = calculated expiry

Repeated verification is idempotent.

## Install

```bash
npm install
npm start
```

Run `shop_subscriptions.sql` in Supabase first.

Never put CASHFREE_SECRET_KEY or SUPABASE_KEY in frontend code.
