const { MongoClient } = require('mongodb');
const express = require('express');
const { VoiceResponse, MessagingResponse } = require('twilio').twiml;
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// MongoDB connection
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://pizzavoice:PizzaVoice2024!@cluster0.iygqt51.mongodb.net/?appName=Cluster0';
const DB_NAME = 'pizzavoice';
let db;
let ordersCollection;
let callsCollection;

async function connectDB() {
  try {
    const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    db = client.db(DB_NAME);
    ordersCollection = db.collection('orders');
    callsCollection = db.collection('calls');
    console.log('✅ MongoDB connected successfully');
  } catch (err) {
    console.error('❌ MongoDB connection failed:', err.message);
    // Fall back to in-memory
    ordersMap = new Map();
    callsMap = new Map();
  }
}
connectDB();

// ─── MENU & DEALS ───────────────────────────────
const MENU = {
  pepperoni:   { name: 'Pepperoni Pizza',              price: 14.99 },
  margherita:  { name: 'Margherita Pizza',            price: 13.99 },
  bbq:         { name: 'BBQ Bacon Cheeseburger Pizza', price: 17.99 },
  buffalo:     { name: 'Buffalo Chicken Pizza',       price: 16.99 },
  vegan:       { name: 'Vegan Garden Pizza',           price: 15.99 },
  wings:       { name: 'Buffalo Wings (8pc)',          price: 11.99 },
  breadsticks: { name: 'Garlic Breadsticks',           price:  6.99 },
  salad:       { name: 'Caesar Salad',                 price:  7.99 },
  coke:        { name: 'Coca-Cola 2L',                 price:  3.99 },
  lemonade:    { name: 'Lemonade',                     price:  3.49 },
  water:       { name: 'Water Bottle',                 price:  1.99 },
  dessert:     { name: 'Cinnabon Stuffed Breadsticks',  price:  7.99 },
};

const DEALS = {
  PIZZA50:      { desc: '50% OFF Large Pizza',      type: 'percent', value: 50 },
  WINGS4:       { desc: 'Buy 4 Wings Get 4 FREE',   type: 'bogo',    value: 50 },
  FREEDELIVERY: { desc: 'Free Delivery',             type: 'fixed',   value: 4.99 },
  FIRSTORDER:   { desc: '15% OFF First Order',       type: 'percent', value: 15 },
};

function generateOrderNumber() { return '#' + Math.floor(1000 + Math.random() * 9000); }
function fmt(n) { return '$' + parseFloat(n).toFixed(2); }

function parseOrderItem(text) {
  const qtyMatch = text.match(/(\d+)\s*(x|lat|large|medium|small|pizza|order|piece|pc)?/i);
  const qty = qtyMatch ? parseInt(qtyMatch[1]) : 1;
  const lower = text.toLowerCase();
  for (const [key, item] of Object.entries(MENU)) {
    if (lower.includes(key)) {
      return { name: item.name, qty, unitPrice: item.price, lineTotal: item.price * qty };
    }
  }
  return null;
}

// ─── AI ORDER TAKER ─────────────────────────────
function generateAIResponse(text, state) {
  const lower = text.toLowerCase();

  // Only greet on true greeting words — NOT "order" (that's handled in ordering stage)
  if (state.stage === 'greeting' && /^hi|hey|hello|start$/i.test(text)) {
    state.stage = 'ordering';
    state.order = []; state.cartTotal = 0; state.deal = null;
    return "Hi! Welcome to Domino's. I'm your AI ordering assistant. What can I get started for you today?";
  }

  if (/menu|what do you have|what's on|what do you serve/i.test(text)) {
    const items = Object.values(MENU).map(i => `${i.name} at ${fmt(i.price)}`).join('. ');
    return `Here's our menu: ${items}. What would you like?`;
  }

  if (/deal|discount|special/i.test(text)) {
    return `Deals: PIZZA50 (50% off pizza), WINGS4 (BOGO wings), FREEDELIVERY, FIRSTORDER (15% off). Say the code when ready!`;
  }

  for (const [code, deal] of Object.entries(DEALS)) {
    if (lower.includes(code.toLowerCase())) {
      state.deal = deal;
      return `Deal applied! ${deal.desc}. Anything else?`;
    }
  }

  const item = parseOrderItem(text);
  if (item) {
    state.order.push(item);
    state.cartTotal += item.lineTotal;
    const dealStr = state.deal ? ` (${state.deal.desc} applied)` : '';
    return `${item.name} added!${dealStr} Anything else or ready to confirm?`;
  }

  if (/confirm|yes|yeah|yep|done|place order|that's all/i.test(text)) {
    if (state.order.length === 0) return "Your order is empty! What would you like?";
    state.stage = 'confirming';
    const itemsList = state.order.map(i => `${i.qty > 1 ? i.qty + ' ' : ''}${i.name}`).join(', ');
    return `Order: ${itemsList}. Subtotal: ${fmt(state.cartTotal)}. Say YES to confirm, or add more items.`;
  }

  if (/cancel|nevermind|stop/i.test(text)) {
    state.order = []; state.cartTotal = 0;
    return "Order cancelled. Call us back anytime!";
  }

  if (/price|cost|how much/i.test(text)) return "Pizzas start at $13.99. Specialty $16.99-$17.99. Sides from $1.99. What would you like?";
  if (/hour|open|close|when|address|where/i.test(text)) return "We're at 142 Broadway, New York NY 10013. Open 10AM-midnight daily!";

  return "I didn't catch that. Say what you'd like to order, or ask for our menu.";
}

// ─── VOICE WEBHOOK ──────────────────────────────
app.post('/voice', async (req, res) => {
  const callSid = req.body.CallSid || 'demo-' + Date.now();
  const speechResult = req.body.SpeechResult || '';
  const callerPhone = req.body.From || 'Unknown';

  // Get or create call session
  let state;
  if (callsCollection) {
    const existing = await callsCollection.findOne({ callSid });
    state = existing?.state || { stage: 'greeting', order: [], cartTotal: 0, deal: null };
  } else {
    state = { stage: 'greeting', order: [], cartTotal: 0, deal: null };
  }

  let response;

  // FIRST entry — always greet and transition to ordering
  if (state.stage === 'greeting' && !speechResult.trim()) {
    response = "Hi! Welcome to Domino's. I'm your AI ordering assistant. What can I get started for you today?";
    state.stage = 'ordering';
  } else if (speechResult.trim()) {
    // Active speech input — process it
    response = generateAIResponse(speechResult, state);
  }
  // Else: Gather timeout with empty speech → no response text, just re-Gather

  // Check for order confirmation
  if (state.stage === 'confirming' && /yes|yeah|yep|confirm|do it|place/i.test(speechResult)) {
    const orderNum = generateOrderNumber();
    let total = state.cartTotal;
    if (state.deal) {
      if (state.deal.type === 'percent') total = total * (1 - state.deal.value / 100);
      else if (state.deal.type === 'fixed') total = total - state.deal.value;
    }
    const tax = total * 0.085;
    const finalTotal = total + tax;
    const taxRate = 0.085;

    const order = {
      id: 'ord-' + Date.now(),
      orderNumber: orderNum,
      customerPhone: callerPhone,
      items: state.order,
      subtotal: state.cartTotal,
      tax: +(state.cartTotal * taxRate).toFixed(2),
      total: finalTotal,
      deal: state.deal?.desc || null,
      status: 'received',
      callSid,
      createdAt: new Date().toISOString(),
    };

    // Save to MongoDB
    if (ordersCollection) {
      try {
        await ordersCollection.insertOne(order);
        console.log('✅ Order saved to MongoDB:', order.orderNumber);
      } catch (err) {
        console.error('MongoDB insert error:', err.message);
      }
    }

    response = `Perfect! Order ${orderNum} confirmed! Total: ${fmt(finalTotal)}. You'll get a text receipt shortly. Thanks for calling Domino's!`;
    state.stage = 'confirmed';
    state.order = []; state.cartTotal = 0;

    // Send SMS receipt
    if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
      const twilio = require('twilio');
      const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      const itemList = order.items.map(i => `${i.qty > 1 ? i.qty + 'x ' : ''}${i.name}`).join(', ');
      client.messages.create({
        body: `🍕 Domino's Order ${orderNum} Confirmed!\n\n${itemList}\n\nSubtotal: ${fmt(order.subtotal)}\nTax: ${fmt(order.tax)}\nTotal: ${fmt(order.total)}\n\nEst. wait: 25-35 min\nThank you!`,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: callerPhone,
      }).catch(err => console.log('SMS error:', err.message));
    }
  }

  // Save call session state
  if (callsCollection) {
    try {
      await callsCollection.updateOne(
        { callSid },
        { $set: { callSid, state, updatedAt: new Date().toISOString() } },
        { upsert: true }
      );
    } catch (err) {
      console.error('calls upsert error:', err.message);
    }
  }

  const twiml = new VoiceResponse();
  twiml.say({ voice: 'alice', bargeIn: true }, response);

  if (state.stage !== 'confirmed') {
    const g = twiml.gather({
      input: 'speech', action: '/voice', method: 'POST',
      language: 'en-US', bargeIn: true, timeout: 6,
    });
    g.say({ voice: 'alice' }, 'Go ahead.');
  } else {
    twiml.say({ voice: 'alice' }, 'Goodbye!');
  }

  res.type('text/xml').send(twiml.toString());
});

// ─── SMS WEBHOOK ────────────────────────────────
app.post('/sms', (req, res) => {
  const twiml = new MessagingResponse();
  twiml.message(`Thanks for texting Domino's! Call ${process.env.TWILIO_PHONE_NUMBER} to order. Open 10AM-midnight daily!`);
  res.type('text/xml').send(twiml.toString());
});

// ─── REST API ───────────────────────────────────
app.get('/api/orders', async (req, res) => {
  if (ordersCollection) {
    try {
      const allOrders = await ordersCollection.find({}).sort({ createdAt: -1 }).toArray();
      return res.json(allOrders);
    } catch (err) {
      console.error('API orders error:', err.message);
    }
  }
  res.json([]);
});

app.get('/api/orders/:id', async (req, res) => {
  if (ordersCollection) {
    try {
      const order = await ordersCollection.findOne({ id: req.params.id });
      if (!order) return res.status(404).json({ error: 'Not found' });
      return res.json(order);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }
  res.status(500).json({ error: 'DB not connected' });
});

app.patch('/api/orders/:id/status', async (req, res) => {
  if (ordersCollection) {
    try {
      const result = await ordersCollection.findOneAndUpdate(
        { id: req.params.id },
        { $set: { status: req.body.status, updatedAt: new Date().toISOString() } },
        { returnDocument: 'after' }
      );
      if (!result) return res.status(404).json({ error: 'Not found' });
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }
  res.status(500).json({ error: 'DB not connected' });
});

app.get('/api/stats', async (req, res) => {
  const today = new Date().toDateString();
  if (ordersCollection) {
    try {
      const todayOrders = await ordersCollection.find({
        createdAt: { $regex: today }
      }).toArray();
      const revenue = todayOrders.reduce((s, o) => s + (o.total || 0), 0);
      return res.json({
        ordersToday: todayOrders.length,
        revenueToday: revenue,
        avgOrder: todayOrders.length > 0 ? revenue / todayOrders.length : 0,
      });
    } catch (err) {
      return res.json({ ordersToday: 0, revenueToday: 0, avgOrder: 0 });
    }
  }
  res.json({ ordersToday: 0, revenueToday: 0, avgOrder: 0 });
});

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'PizzaVoice AI',
    mongodb: ordersCollection ? 'connected' : 'not connected',
    time: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🍕 PizzaVoice AI running on port ${PORT}`);
});
