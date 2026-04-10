const { MongoClient } = require('mongodb');
const express = require('express');
const { VoiceResponse, MessagingResponse } = require('twilio').twiml;
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ------------------------------
// Config
// ------------------------------
const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = process.env.DB_NAME || 'pizzavoice';
const STORE_NAME = process.env.STORE_NAME || "Domino's";
const STORE_ADDRESS = process.env.STORE_ADDRESS || '142 Broadway, New York NY 10013';
const STORE_HOURS = process.env.STORE_HOURS || '10 AM to midnight daily';
const TAX_RATE = Number(process.env.TAX_RATE || 0.085);

if (!MONGO_URI) {
  console.warn('⚠️ MONGO_URI is not set. Falling back to in-memory storage.');
}

let db;
let ordersCollection;
let callsCollection;
let mongoClient;
let ordersMap = new Map();
let callsMap = new Map();

async function connectDB() {
  if (!MONGO_URI) return;

  try {
    mongoClient = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
    await mongoClient.connect();
    db = mongoClient.db(DB_NAME);
    ordersCollection = db.collection('orders');
    callsCollection = db.collection('calls');
    console.log('✅ MongoDB connected successfully');
  } catch (err) {
    console.error('❌ MongoDB connection failed:', err.message);
    ordersCollection = null;
    callsCollection = null;
  }
}

connectDB();

// ------------------------------
// Menu + deals
// ------------------------------
const MENU = {
  pepperoni: { name: 'Pepperoni Pizza', price: 14.99, synonyms: ['pepperoni'] },
  margherita: { name: 'Margherita Pizza', price: 13.99, synonyms: ['margherita'] },
  bbq: { name: 'BBQ Bacon Cheeseburger Pizza', price: 17.99, synonyms: ['bbq', 'barbecue'] },
  buffalo: { name: 'Buffalo Chicken Pizza', price: 16.99, synonyms: ['buffalo chicken', 'buffalo'] },
  vegan: { name: 'Vegan Garden Pizza', price: 15.99, synonyms: ['vegan garden', 'vegan'] },
  wings: { name: 'Buffalo Wings (8pc)', price: 11.99, synonyms: ['wings', 'buffalo wings'] },
  breadsticks: { name: 'Garlic Breadsticks', price: 6.99, synonyms: ['breadsticks', 'garlic breadsticks'] },
  salad: { name: 'Caesar Salad', price: 7.99, synonyms: ['salad', 'caesar salad'] },
  coke: { name: 'Coca-Cola 2L', price: 3.99, synonyms: ['coke', 'coca cola', 'coca-cola'] },
  lemonade: { name: 'Lemonade', price: 3.49, synonyms: ['lemonade'] },
  water: { name: 'Water Bottle', price: 1.99, synonyms: ['water', 'water bottle'] },
  dessert: { name: 'Cinnabon Stuffed Breadsticks', price: 7.99, synonyms: ['dessert', 'cinnabon', 'stuffed breadsticks'] },
};

const DEALS = {
  PIZZA50: { code: 'PIZZA50', desc: '50% off one pizza item', type: 'percent', value: 50, appliesTo: 'pizza' },
  WINGS4: { code: 'WINGS4', desc: 'Buy 4 wings get 4 free', type: 'info', value: 0, appliesTo: 'wings' },
  FREEDELIVERY: { code: 'FREEDELIVERY', desc: 'Free delivery', type: 'fixed', value: 4.99, appliesTo: 'order' },
  FIRSTORDER: { code: 'FIRSTORDER', desc: '15% off your first order', type: 'percent', value: 15, appliesTo: 'order' },
};

function generateOrderNumber() {
  return '#' + Math.floor(1000 + Math.random() * 9000);
}

function fmt(n) {
  return '$' + Number(n).toFixed(2);
}

function isPizzaItem(name) {
  return /pizza/i.test(name);
}

function createInitialState() {
  return {
    stage: 'greeting',
    order: [],
    cartTotal: 0,
    deal: null,
    customerName: null,
    lastPrompt: null,
  };
}

function recalcCartTotal(order) {
  return order.reduce((sum, item) => sum + Number(item.lineTotal || 0), 0);
}

function getStorage(collection, map, keyField) {
  return {
    async get(key) {
      if (collection) {
        const row = await collection.findOne({ [keyField]: key });
        return row || null;
      }
      return map.get(key) || null;
    },
    async set(key, value) {
      if (collection) {
        await collection.updateOne(
          { [keyField]: key },
          { $set: { ...value, [keyField]: key, updatedAt: new Date() } },
          { upsert: true }
        );
        return;
      }
      map.set(key, { ...value, [keyField]: key, updatedAt: new Date() });
    },
    async insert(doc) {
      if (collection) {
        await collection.insertOne(doc);
        return;
      }
      map.set(doc[keyField], doc);
    },
    async list() {
      if (collection) {
        return collection.find({}).sort({ createdAt: -1 }).toArray();
      }
      return Array.from(map.values()).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    },
  };
}

const orderStore = getStorage(ordersCollection, ordersMap, 'id');
const callStore = getStorage(callsCollection, callsMap, 'callSid');

function normalizeText(text = '') {
  return text.trim().toLowerCase();
}

function containsAny(text, phrases) {
  return phrases.some((phrase) => text.includes(phrase));
}

function parseQuantity(text) {
  const match = text.match(/\b(\d{1,2})\b/);
  return match ? Math.max(1, parseInt(match[1], 10)) : 1;
}

function parseOrderItem(text) {
  const lower = normalizeText(text);
  const qty = parseQuantity(lower);

  for (const item of Object.values(MENU)) {
    if (item.synonyms.some((syn) => lower.includes(syn))) {
      return {
        name: item.name,
        qty,
        unitPrice: item.price,
        lineTotal: Number((item.price * qty).toFixed(2)),
      };
    }
  }

  return null;
}

function summarizeOrder(order) {
  if (!order.length) return 'nothing yet';
  return order
    .map((i) => `${i.qty > 1 ? `${i.qty} ` : ''}${i.name}`)
    .join(', ');
}

function applyDeal(subtotal, order, deal) {
  if (!deal) {
    return {
      subtotal,
      discount: 0,
      totalBeforeTax: subtotal,
      note: null,
    };
  }

  let discount = 0;
  let note = deal.desc;

  if (deal.code === 'PIZZA50') {
    const pizzaItem = order.find((i) => isPizzaItem(i.name));
    if (pizzaItem) {
      discount = Number((pizzaItem.lineTotal * 0.5).toFixed(2));
    }
  } else if (deal.code === 'FIRSTORDER') {
    discount = Number((subtotal * 0.15).toFixed(2));
  } else if (deal.code === 'FREEDELIVERY') {
    discount = Number(Math.min(4.99, subtotal).toFixed(2));
  } else if (deal.code === 'WINGS4') {
    note = 'WINGS4 noted. Staff can verify wing promo at checkout.';
  }

  const totalBeforeTax = Math.max(0, Number((subtotal - discount).toFixed(2)));

  return {
    subtotal,
    discount,
    totalBeforeTax,
    note,
  };
}

function getMenuSpeech() {
  return Object.values(MENU)
    .map((i) => `${i.name} for ${fmt(i.price)}`)
    .join('. ');
}

function getDealsSpeech() {
  return Object.values(DEALS)
    .map((d) => `${d.code}: ${d.desc}`)
    .join('. ');
}

function generateAIResponse(text, state) {
  const lower = normalizeText(text);

  if (!lower) {
    return "Sorry, I didn't catch that. You can say something like pepperoni pizza, wings, or menu.";
  }

  if (state.stage === 'greeting' && /^(hi|hey|hello|start|good morning|good afternoon|good evening)\b/i.test(text.trim())) {
    state.stage = 'ordering';
    return `Hi there. Welcome to ${STORE_NAME}. What can I get started for you today?`;
  }

  if (containsAny(lower, ['menu', 'what do you have', "what's on", 'what do you serve'])) {
    state.stage = 'ordering';
    return `Sure, here are a few favorites. ${getMenuSpeech()}. What sounds good?`;
  }

  if (containsAny(lower, ['deal', 'discount', 'special', 'coupon', 'promo'])) {
    return `Right now we have these deals: ${getDealsSpeech()}. Just say the code if you want me to apply one.`;
  }

  for (const deal of Object.values(DEALS)) {
    if (lower.includes(deal.code.toLowerCase())) {
      state.deal = deal;
      return `Got it. I applied ${deal.code}. ${deal.desc}. What else would you like?`;
    }
  }

  if (containsAny(lower, ['cancel', 'never mind', 'nevermind', 'stop', 'start over'])) {
    state.stage = 'ordering';
    state.order = [];
    state.cartTotal = 0;
    state.deal = null;
    return 'No problem. I cleared the order. What would you like instead?';
  }

  if (containsAny(lower, ['hours', 'open', 'close'])) {
    return `We're open ${STORE_HOURS}.`;
  }

  if (containsAny(lower, ['address', 'where are you', 'location'])) {
    return `We're located at ${STORE_ADDRESS}.`;
  }

  if (containsAny(lower, ['price', 'cost', 'how much'])) {
    return 'Our pizzas start at $13.99, specialty pizzas run up to $17.99, and sides start at $1.99. What would you like?';
  }

  const item = parseOrderItem(lower);
  if (item) {
    state.stage = 'ordering';
    state.order.push(item);
    state.cartTotal = recalcCartTotal(state.order);
    return `Perfect. I added ${item.qty > 1 ? `${item.qty} ` : ''}${item.name}. Your subtotal is ${fmt(state.cartTotal)}. Anything else?`;
  }

  if (containsAny(lower, ['confirm', 'that is all', "that's all", 'done', 'place order', 'checkout'])) {
    if (!state.order.length) {
      return "Your cart is empty right now. You can say something like one pepperoni pizza and wings.";
    }

    state.stage = 'confirming';
    const pricing = applyDeal(state.cartTotal, state.order, state.deal);
    const tax = Number((pricing.totalBeforeTax * TAX_RATE).toFixed(2));
    const total = Number((pricing.totalBeforeTax + tax).toFixed(2));
    const discountText = pricing.discount > 0 ? ` After discount, you're at ${fmt(pricing.totalBeforeTax)} before tax.` : '';

    return `Okay, I have ${summarizeOrder(state.order)}. Subtotal is ${fmt(state.cartTotal)}.${discountText} Estimated total with tax is ${fmt(total)}. Say yes to place it, or tell me what you'd like to change.`;
  }

  if (state.stage === 'confirming' && containsAny(lower, ['add', 'change', 'remove'])) {
    state.stage = 'ordering';
    return 'Sure, let’s update it. Tell me what you want to add or change.';
  }

  return "I want to make sure I get that right. You can say menu, ask for deals, or tell me the item you'd like to order.";
}

async function getCallState(callSid) {
  try {
    const existing = await callStore.get(callSid);
    return existing?.state || createInitialState();
  } catch (err) {
    console.error('State read error:', err.message);
    return createInitialState();
  }
}

async function saveCallState(callSid, state) {
  try {
    await callStore.set(callSid, { state, callSid, updatedAt: new Date() });
  } catch (err) {
    console.error('State save error:', err.message);
  }
}

function buildVoiceResponse(message, gatherPrompt = 'Go ahead.') {
  const twiml = new VoiceResponse();

  if (message) {
    twiml.say({ voice: 'alice' }, message);
  }

  const gather = twiml.gather({
    input: 'speech',
    action: '/voice',
    method: 'POST',
    language: 'en-US',
    speechTimeout: 'auto',
    timeout: 5,
  });
  gather.say({ voice: 'alice' }, gatherPrompt);

  return twiml;
}

// ------------------------------
// Voice webhook
// ------------------------------
app.post('/voice', async (req, res) => {
  const callSid = req.body.CallSid || `demo-${Date.now()}`;
  const speechResult = req.body.SpeechResult || '';
  const callerPhone = req.body.From || 'Unknown';

  const state = await getCallState(callSid);
  let responseText = '';

  const normalizedSpeech = normalizeText(speechResult);

  if (state.stage === 'greeting' && !normalizedSpeech) {
    state.stage = 'ordering';
    responseText = `Hi there. Thanks for calling ${STORE_NAME}. I can help you place an order, hear the menu, or apply a deal. What would you like today?`;
  } else if (state.stage === 'confirming' && containsAny(normalizedSpeech, ['yes', 'yeah', 'yep', 'confirm', 'place it', 'do it'])) {
    const pricing = applyDeal(state.cartTotal, state.order, state.deal);
    const tax = Number((pricing.totalBeforeTax * TAX_RATE).toFixed(2));
    const finalTotal = Number((pricing.totalBeforeTax + tax).toFixed(2));
    const orderNum = generateOrderNumber();

    const order = {
      id: `ord-${Date.now()}`,
      orderNumber: orderNum,
      customerPhone: callerPhone,
      items: state.order,
      subtotal: Number(state.cartTotal.toFixed(2)),
      discount: pricing.discount,
      tax,
      total: finalTotal,
      deal: state.deal?.desc || null,
      status: 'received',
      callSid,
      createdAt: new Date(),
    };

    try {
      await orderStore.insert(order);
      console.log('✅ Order saved:', order.orderNumber);
    } catch (err) {
      console.error('Order save error:', err.message);
    }

    responseText = `Perfect. Your order ${orderNum} is confirmed. Your total is ${fmt(finalTotal)}. You’ll get a text receipt shortly. Thanks for calling ${STORE_NAME}.`;

    if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER && callerPhone !== 'Unknown') {
      try {
        const twilio = require('twilio');
        const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
        const itemList = order.items.map((i) => `${i.qty > 1 ? `${i.qty}x ` : ''}${i.name}`).join(', ');
        await client.messages.create({
          body: `${STORE_NAME} order ${orderNum} confirmed. Items: ${itemList}. Subtotal: ${fmt(order.subtotal)}. Discount: ${fmt(order.discount)}. Tax: ${fmt(order.tax)}. Total: ${fmt(order.total)}. Estimated wait: 25 to 35 minutes.`,
          from: process.env.TWILIO_PHONE_NUMBER,
          to: callerPhone,
        });
      } catch (err) {
        console.error('SMS error:', err.message);
      }
    }

    state.stage = 'confirmed';
    state.order = [];
    state.cartTotal = 0;
    state.deal = null;
  } else if (normalizedSpeech) {
    responseText = generateAIResponse(speechResult, state);
  } else {
    responseText = "Sorry, I didn't hear anything. You can tell me your order whenever you're ready.";
  }

  await saveCallState(callSid, state);

  let twiml;
  if (state.stage === 'confirmed') {
    twiml = new VoiceResponse();
    twiml.say({ voice: 'alice' }, responseText);
    twiml.say({ voice: 'alice' }, 'Goodbye.');
  } else {
    twiml = buildVoiceResponse(responseText);
  }

  res.type('text/xml').send(twiml.toString());
});

// ------------------------------
// SMS webhook
// ------------------------------
app.post('/sms', (req, res) => {
  const twiml = new MessagingResponse();
  twiml.message(`Thanks for texting ${STORE_NAME}. To place an order, call ${process.env.TWILIO_PHONE_NUMBER || 'our store number'}. We're open ${STORE_HOURS}.`);
  res.type('text/xml').send(twiml.toString());
});

// ------------------------------
// REST API
// ------------------------------
app.get('/api/orders', async (req, res) => {
  try {
    const allOrders = await orderStore.list();
    res.json(allOrders);
  } catch (err) {
    console.error('API orders error:', err.message);
    res.status(500).json({ error: 'Unable to fetch orders' });
  }
});

app.get('/api/orders/:id', async (req, res) => {
  try {
    const orders = await orderStore.list();
    const order = orders.find((o) => o.id === req.params.id);
    if (!order) return res.status(404).json({ error: 'Not found' });
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/orders/:id/status', async (req, res) => {
  try {
    if (!ordersCollection) {
      const order = ordersMap.get(req.params.id);
      if (!order) return res.status(404).json({ error: 'Not found' });
      order.status = req.body.status;
      order.updatedAt = new Date();
      ordersMap.set(req.params.id, order);
      return res.json(order);
    }

    const result = await ordersCollection.findOneAndUpdate(
      { id: req.params.id },
      { $set: { status: req.body.status, updatedAt: new Date() } },
      { returnDocument: 'after' }
    );

    if (!result || !result.value) return res.status(404).json({ error: 'Not found' });
    res.json(result.value);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const allOrders = await orderStore.list();
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

    const todayOrders = allOrders.filter((order) => {
      const createdAt = new Date(order.createdAt);
      return createdAt >= startOfToday && createdAt < endOfToday;
    });

    const revenue = todayOrders.reduce((sum, o) => sum + Number(o.total || 0), 0);

    res.json({
      ordersToday: todayOrders.length,
      revenueToday: Number(revenue.toFixed(2)),
      avgOrder: todayOrders.length ? Number((revenue / todayOrders.length).toFixed(2)) : 0,
    });
  } catch (err) {
    res.status(500).json({ error: 'Unable to calculate stats' });
  }
});

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'PizzaVoice AI',
    mongodb: ordersCollection ? 'connected' : 'in-memory fallback',
    time: new Date().toISOString(),
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🍕 PizzaVoice AI running on port ${PORT}`);
});

process.on('SIGINT', async () => {
  try {
    if (mongoClient) {
      await mongoClient.close();
      console.log('MongoDB connection closed');
    }
  } finally {
    process.exit(0);
  }
});
