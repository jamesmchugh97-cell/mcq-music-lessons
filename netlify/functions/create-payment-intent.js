// Netlify serverless function: actually charges the card server-side.
// Requires a STRIPE_SECRET_KEY environment variable to be set in your
// Netlify site settings (Site configuration -> Environment variables).
// Use your Stripe SECRET key here (starts with sk_live_ or sk_test_),
// never the publishable key (pk_...) that's already in the HTML.

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ success: false, error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Invalid request body' }) };
  }

  const { amount, payment_method_id, email, description } = body;

  if (!amount || !payment_method_id || amount <= 0) {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: 'Missing amount or payment method.' }) };
  }

  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount), // amount in cents (smallest currency unit)
      currency: 'aud',
      payment_method: payment_method_id,
      confirm: true,
      receipt_email: email || undefined,
      description: description || 'MCQ Music Lessons booking',
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' }
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        status: paymentIntent.status,
        client_secret: paymentIntent.client_secret
      })
    };
  } catch (err) {
    return {
      statusCode: 200,
      body: JSON.stringify({ success: false, error: err.message })
    };
  }
};
