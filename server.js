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
let ordersCollection = null;
let callsCollection = null;
let mongoClient = null;
const ordersMap = new Map();
const callsMap = new Map();

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
  pepperoni: { name: 'Pepperoni Pizza', price: 14.99, category: 'pizza', synonyms: ['pepperoni pizza', 'pepperoni'] },
  margherita: { name: 'Margherita Pizza', price: 13.99, category: 'pizza', synonyms: ['margherita pizza', 'margherita'] },
  bbq: { name: 'BBQ Bacon Cheeseburger Pizza', price: 17.99, category: 'pizza', synonyms: ['bbq bacon cheeseburger pizza', 'bbq pizza', 'barbecue pizza', 'bbq'] },
  buffalo: { name: 'Buffalo Chicken Pizza', price: 16.99, category: 'pizza', synonyms: ['buffalo chicken pizza', 'buffalo pizza', 'buffalo chicken', 'buffalo'] },
  vegan: { name: 'Vegan Garden Pizza', price: 15.99, category: 'pizza', synonyms: ['vegan garden pizza', 'vegan pizza', 'vegan'] },
  wings: { name: 'Buffalo Wings (8pc)', price: 11.99, category: 'side', synonyms: ['wings', 'buffalo wings'] },
  breadsticks: { name: 'Garlic Breadsticks', price: 6.99, category: 'side', synonyms: ['breadsticks', 'garlic breadsticks'] },
  salad: { name: 'Caesar Salad', price: 7.99, category: 'side', synonyms: ['salad', 'caesar salad'] },
  coke: { name: 'Coca-Cola 2L', price: 3.99, category: 'drink', synonyms: ['coke', 'coca cola', 'coca-cola', 'soda'] },
  lemonade: { name: 'Lemonade', price: 3.49, category: 'drink', synonyms: ['lemonade'] },
  water: { name: 'Water Bottle', price: 1.99, category: 'drink', synonyms: ['water', 'water bottle'] },
  dessert: { name: 'Cinnabon Stuffed Breadsticks', price: 7.99, category: 'dessert', synonyms: ['dessert', 'cinnabon', 'stuffed breadsticks'] },
};

const DEALS = {
  PIZZA50: { code: 'PIZZA50', desc: '50% off one pizza item', type: 'percent', value: 50, appliesTo: 'pizza' },
  WINGS4: { code: 'WINGS4', desc: 'Buy 4 wings get 4 free', type: 'info', value: 0, appliesTo: 'wings' },
  FREEDELIVERY: { code: 'FREEDELIVERY', desc: 'Free delivery', type: 'fixed', value: 4.99, appliesTo: 'delivery' },
  FIRSTORDER: { code: 'FIRSTORDER', desc: '15% off your first order', type: 'percent', value: 15, appliesTo: 'order' },
};

function generateOrderNumber() {
  return '#' + Math.floor(1000 + Math.random() * 9000);
}

function fmt(n) {
  return '$' + Number(n).toFixed(2);
}

function normalizeText(text = '') {
  return text.trim().toLowerCase();
}

function containsAny(text, phrases) {
  return phrases.some((phrase) => text.includes(phrase));
}

function createInitialState() {
  return {
    stage: 'greeting',
    order: [],
    cartTotal: 0,
    deal: null,
    fulfillment: null,
    customerName: null,
    deliveryAddress: null,
    pendingAddressConfirmation: false,
    lastPrompt: null,
  };
}

function recalcCartTotal(order) {
  return Number(order.reduce((sum, item) => sum + Number(item.lineTotal || 0), 0).toFixed(2));
}

async function getCallState(callSid) {
  try {
    if (callsCollection) {
      const existing = await callsCollection.findOne({ callSid });
      return existing?.state || createInitialState();
    }
    return callsMap.get(callSid)?.state || createInitialState();
  } catch (err) {
    console.error('State read error:', err.message);
    return createInitialState();
  }
}

async function saveCallState(callSid, state) {
  try {
    if (callsCollection) {
      await callsCollection.updateOne(
        { callSid },
        { $set: { callSid, state, updatedAt: new Date() } },
        { upsert: true }
      );
      return;
    }

    callsMap.set(callSid, { callSid, state, updatedAt: new Date() });
  } catch (err) {
    console.error('State save error:', err.message);
  }
}

async function insertOrder(order) {
  if (ordersCollection) {
    await ordersCollection.insertOne(order);
    return;
  }
  ordersMap.set(order.id, order);
}

async function listOrders() {
  if (ordersCollection) {
    return ordersCollection.find({}).sort({ createdAt: -1 }).toArray();
  }
  return Array.from(ordersMap.values()).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function parseQuantity(text) {
  const numberWords = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
  };

  const digitMatch = text.match(/\b(\d{1,2})\b/);
  if (digitMatch) return Math.max(1, parseInt(digitMatch[1], 10));

  for (const [word, value] of Object.entries(numberWords)) {
    if (text.includes(word)) return value;
  }

  return 1;
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
        category: item.category,
      };
    }
  }

  if (lower.includes('pizza')) {
    return {
      name: 'Cheese Pizza',
      qty,
      unitPrice: 12.99,
      lineTotal: Number((12.99 * qty).toFixed(2)),
      category: 'pizza',
    };
  }

  return null;
}

function summarizeOrder(order) {
  if (!order.length) return 'nothing yet';
  return order
    .map((i) => `${i.qty > 1 ? `${i.qty} ` : ''}${i.name}`)
    .join(', ');
}

function getMenuSummary(type = 'full') {
  const values = Object.values(MENU);

  if (type === 'pizza') {
    return values
      .filter((i) => i.category === 'pizza')
      .map((i) => `${i.name} for ${fmt(i.price)}`)
      .join('. ');
  }

  if (type === 'side') {
    return values
      .filter((i) => i.category === 'side')
      .map((i) => `${i.name} for ${fmt(i.price)}`)
      .join('. ');
  }

  if (type === 'drink') {
    return values
      .filter((i) => i.category === 'drink')
      .map((i) => `${i.name} for ${fmt(i.price)}`)
      .join('. ');
  }

  return values.map((i) => `${i.name} for ${fmt(i.price)}`).join('. ');
}

function getDealsSpeech() {
  return Object.values(DEALS)
    .map((d) => `${d.code}: ${d.desc}`)
    .join('. ');
}

function inferMenuIntent(text) {
  const lower = normalizeText(text);

  if (!containsAny(lower, ['menu', 'what do you have', 'what do you serve', 'what kind of'])) {
    return null;
  }

  if (containsAny(lower, ['pizza', 'pizzas'])) return 'pizza';
  if (containsAny(lower, ['side', 'sides', 'appetizer', 'appetizers', 'wings', 'breadsticks', 'salad'])) return 'side';
  if (containsAny(lower, ['drink', 'drinks', 'beverage', 'beverages', 'soda'])) return 'drink';

  return 'full';
}

function applyDeal(subtotal, order, deal, fulfillment) {
  if (!deal) {
    return { subtotal, discount: 0, totalBeforeTax: subtotal, note: null };
  }

  let discount = 0;
  let note = deal.desc;

  if (deal.code === 'PIZZA50') {
    const pizzaItem = order.find((i) => i.category === 'pizza');
    if (pizzaItem) {
      discount = Number((pizzaItem.lineTotal * 0.5).toFixed(2));
    } else {
      note = 'PIZZA50 is available when a pizza is in the order.';
    }
  } else if (deal.code === 'FIRSTORDER') {
    discount = Number((subtotal * 0.15).toFixed(2));
  } else if (deal.code === 'FREEDELIVERY') {
    if (fulfillment === 'delivery') {
      discount = Number(Math.min(4.99, subtotal).toFixed(2));
    } else {
      note = 'FREEDELIVERY only applies to delivery orders.';
    }
  } else if (deal.code === 'WINGS4') {
    note = 'WINGS4 noted. Staff can verify wing promo at checkout.';
  }

  const totalBeforeTax = Math.max(0, Number((subtotal - discount).toFixed(2)));
  return { subtotal, discount, totalBeforeTax, note };
}

function getFulfillmentFromText(text) {
  const lower = normalizeText(text);
  if (containsAny(lower, ['delivery', 'deliver', 'bring it', 'send it'])) return 'delivery';
  if (containsAny(lower, ['pickup', 'pick up', 'carryout', 'carry out', 'i will come'])) return 'pickup';
  return null;
}

function looksLikeAddress(text) {
  const lower = normalizeText(text);
  const hasStreetNumber = /\b\d{1,6}\b/.test(lower);
  const hasStreetWord = /(street|st\b|avenue|ave\b|road|rd\b|drive|dr\b|lane|ln\b|boulevard|blvd\b|way|court|ct\b|place|pl\b|broadway)/.test(lower);
  return hasStreetNumber || hasStreetWord;
}

function naturalConfirmPrompt(state, pricing) {
  const tax = Number((pricing.totalBeforeTax * TAX_RATE).toFixed(2));
  const total = Number((pricing.totalBeforeTax + tax).toFixed(2));
  const orderText = summarizeOrder(state.order);
  const fulfillmentText = state.fulfillment === 'delivery'
    ? `for delivery to ${state.deliveryAddress}`
    : state.fulfillment === 'pickup'
      ? 'for pickup'
      : 'for your order';
  const discountText = pricing.discount > 0 ? ` I applied a discount of ${fmt(pricing.discount)}.` : '';

  return `Alright, let me make sure I have this right. ${orderText}, ${fulfillmentText}. Your subtotal is ${fmt(state.cartTotal)}.${discountText} With tax, your estimated total is ${fmt(total)}. If that looks good, just say yes to place it.`;
}

function removeLastMatchingItem(state, text) {
  const lower = normalizeText(text);
  for (let i = state.order.length - 1; i >= 0; i -= 1) {
    const item = state.order[i];
    if (lower.includes(item.name.toLowerCase().split(' ')[0]) || lower.includes(item.name.toLowerCase())) {
      state.order.splice(i, 1);
      state.cartTotal = recalcCartTotal(state.order);
      return item;
    }
  }
  return null;
}

function generateAIResponse(text, state) {
  const lower = normalizeText(text);

  if (!lower) {
    return "Sorry, I didn't catch that. You can tell me an item, ask for the menu, or say pickup or delivery.";
  }

  if (state.pendingAddressConfirmation && containsAny(lower, ['yes', 'correct', 'that is right', "that's right"])) {
    state.pendingAddressConfirmation = false;
    state.stage = 'ordering';
    return `Perfect. I have your delivery address as ${state.deliveryAddress}. What would you like to order?`;
  }

  if (state.pendingAddressConfirmation && containsAny(lower, ['no', 'wrong', 'change'])) {
    state.pendingAddressConfirmation = false;
    state.deliveryAddress = null;
    state.stage = 'capturing_address';
    return 'No problem. Please say the full delivery address again.';
  }

  if (state.stage === 'capturing_address') {
    if (looksLikeAddress(lower)) {
      state.deliveryAddress = text.trim();
      state.pendingAddressConfirmation = true;
      return `Got it. I heard ${state.deliveryAddress}. Is that correct?`;
    }
    return 'I still need the street address for delivery. Please say the full address, including the street number.';
  }

  if (state.stage === 'greeting' && /^(hi|hey|hello|start|good morning|good afternoon|good evening)\b/i.test(text.trim())) {
    state.stage = 'ordering';
    return `Hi there. Thanks for calling ${STORE_NAME}. Would you like pickup or delivery today?`;
  }

  const fulfillment = getFulfillmentFromText(lower);
  if (fulfillment) {
    state.fulfillment = fulfillment;

    if (fulfillment === 'delivery' && !state.deliveryAddress) {
      state.stage = 'capturing_address';
      return 'Absolutely. This will be a delivery order. What is the delivery address?';
    }

    state.stage = 'ordering';
    return fulfillment === 'pickup'
      ? 'Sounds good. Pickup it is. What would you like to order?'
      : `Great, delivery it is. I have the address as ${state.deliveryAddress}. What would you like to order?`;
  }

  const menuIntent = inferMenuIntent(lower);
  if (menuIntent) {
    if (menuIntent === 'pizza') {
      return `Sure. Our pizza options are ${getMenuSummary('pizza')}. Which one would you like?`;
    }
    if (menuIntent === 'side') {
      return `For sides, we have ${getMenuSummary('side')}. Want to add one?`;
    }
    if (menuIntent === 'drink') {
      return `For drinks, we have ${getMenuSummary('drink')}. What would you like?`;
    }
    return `Sure, here’s a quick menu rundown. ${getMenuSummary('full')}. What sounds good?`;
  }

  if (containsAny(lower, ['deal', 'discount', 'special', 'coupon', 'promo'])) {
    return `Right now we have these deals: ${getDealsSpeech()}. Just say the code if you want me to apply one.`;
  }

  for (const deal of Object.values(DEALS)) {
    if (lower.includes(deal.code.toLowerCase())) {
      state.deal = deal;
      return `Got it. I added ${deal.code}. ${deal.desc}. What else would you like?`;
    }
  }

  if (containsAny(lower, ['cancel', 'never mind', 'nevermind', 'start over', 'clear order'])) {
    state.stage = 'ordering';
    state.order = [];
    state.cartTotal = 0;
    state.deal = null;
    state.fulfillment = null;
    state.deliveryAddress = null;
    state.pendingAddressConfirmation = false;
    return 'No problem. I cleared everything. Would you like pickup or delivery, and what would you like to order?';
  }

  if (containsAny(lower, ['remove', 'take off', 'delete'])) {
    const removed = removeLastMatchingItem(state, text);
    if (removed) {
      return `Okay, I removed ${removed.name}. Your new subtotal is ${fmt(state.cartTotal)}. Anything else?`;
    }
    return 'I did not catch which item you wanted removed. Tell me the item name and I can take it off.';
  }

  if (containsAny(lower, ['hours', 'open', 'close'])) {
    return `We're open ${STORE_HOURS}.`;
  }

  if (containsAny(lower, ['address', 'where are you', 'location'])) {
    return `We're located at ${STORE_ADDRESS}.`;
  }

  if (containsAny(lower, ['price', 'cost', 'how much'])) {
    return 'Our pizzas start at $12.99, specialty pizzas go up to $17.99, and sides start at $1.99. Tell me what you want and I can total it for you.';
  }

  const item = parseOrderItem(lower);
  if (item) {
    state.stage = 'ordering';
    state.order.push(item);
    state.cartTotal = recalcCartTotal(state.order);

    if (!state.fulfillment) {
      return `Perfect. I added ${item.qty > 1 ? `${item.qty} ` : ''}${item.name}. Your subtotal is ${fmt(state.cartTotal)}. Do you want pickup or delivery?`;
    }

    return `Perfect. I added ${item.qty > 1 ? `${item.qty} ` : ''}${item.name}. Your subtotal is ${fmt(state.cartTotal)}. Anything else?`;
  }

  if (containsAny(lower, ['confirm', 'that is all', "that's all", 'done', 'place order', 'checkout', 'ready'])) {
    if (!state.order.length) {
      return "Your cart is empty right now. You can say something like one pepperoni pizza and wings.";
    }

    if (!state.fulfillment) {
      return 'Before I place it, do you want this for pickup or delivery?';
    }

    if (state.fulfillment === 'delivery' && !state.deliveryAddress) {
      state.stage = 'capturing_address';
      return 'Before I place the order, I need the delivery address. Please say the full address.';
    }

    state.stage = 'confirming';
    const pricing = applyDeal(state.cartTotal, state.order, state.deal, state.fulfillment);
    return naturalConfirmPrompt(state, pricing);
  }

  if (state.stage === 'confirming' && containsAny(lower, ['add', 'change', 'remove', 'actually', 'wait'])) {
    state.stage = 'ordering';
    return 'Of course. We can change it. Tell me what you want to add or update.';
  }

  if (looksLikeAddress(lower) && state.fulfillment === 'delivery' && !state.deliveryAddress) {
    state.stage = 'capturing_address';
    state.deliveryAddress = text.trim();
    state.pendingAddressConfirmation = true;
    return `I heard ${state.deliveryAddress}. Is that correct?`;
  }

  return "I want to make sure I get that right. You can tell me an item, ask for the menu, say pickup or delivery, or say place order when you're ready.";
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
    bargeIn: true,
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
  const normalizedSpeech = normalizeText(speechResult);
  let responseText = '';

  if (state.stage === 'greeting' && !normalizedSpeech) {
    state.stage = 'ordering';
    responseText = `Hi there. Thanks for calling ${STORE_NAME}. I can help with pickup, delivery, the menu, and special deals. What can I get started for you today?`;
  } else if (
    state.stage === 'confirming' &&
    containsAny(normalizedSpeech, ['yes', 'yeah', 'yep', 'confirm', 'place it', 'do it', 'sounds good'])
  ) {
    const pricing = applyDeal(state.cartTotal, state.order, state.deal, state.fulfillment);
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
      fulfillment: state.fulfillment,
      deliveryAddress: state.fulfillment === 'delivery' ? state.deliveryAddress : null,
      status: 'received',
      callSid,
      createdAt: new Date(),
    };

    try {
      await insertOrder(order);
      console.log('✅ Order saved:', order.orderNumber);
    } catch (err) {
      console.error('Order save error:', err.message);
    }

    responseText = state.fulfillment === 'delivery'
      ? `Perfect. Your order ${orderNum} is confirmed for delivery to ${state.deliveryAddress}. Your total is ${fmt(finalTotal)}. You’ll get a text receipt shortly. Thanks for calling ${STORE_NAME}.`
      : `Perfect. Your order ${orderNum} is confirmed for pickup. Your total is ${fmt(finalTotal)}. You’ll get a text receipt shortly. Thanks for calling ${STORE_NAME}.`;

    if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER && callerPhone !== 'Unknown') {
      try {
        const twilio = require('twilio');
        const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
        const itemList = order.items.map((i) => `${i.qty > 1 ? `${i.qty}x ` : ''}${i.name}`).join(', ');
        const addressText = order.fulfillment === 'delivery' ? ` Delivery address: ${order.deliveryAddress}.` : ' Pickup order.';

        await client.messages.create({
          body: `${STORE_NAME} order ${orderNum} confirmed. Items: ${itemList}. Subtotal: ${fmt(order.subtotal)}. Discount: ${fmt(order.discount)}. Tax: ${fmt(order.tax)}. Total: ${fmt(order.total)}.${addressText}`,
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
    const allOrders = await listOrders();
    res.json(allOrders);
  } catch (err) {
    console.error('API orders error:', err.message);
    res.status(500).json({ error: 'Unable to fetch orders' });
  }
});

app.get('/api/orders/:id', async (req, res) => {
  try {
    if (ordersCollection) {
      const order = await ordersCollection.findOne({ id: req.params.id });
      if (!order) return res.status(404).json({ error: 'Not found' });
      return res.json(order);
    }

    const order = ordersMap.get(req.params.id);
    if (!order) return res.status(404).json({ error: 'Not found' });
    return res.json(order);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.patch('/api/orders/:id/status', async (req, res) => {
  try {
    if (ordersCollection) {
      const result = await ordersCollection.findOneAndUpdate(
        { id: req.params.id },
        { $set: { status: req.body.status, updatedAt: new Date() } },
        { returnDocument: 'after' }
      );

      if (!result || !result.value) return res.status(404).json({ error: 'Not found' });
      return res.json(result.value);
    }

    const order = ordersMap.get(req.params.id);
    if (!order) return res.status(404).json({ error: 'Not found' });

    order.status = req.body.status;
    order.updatedAt = new Date();
    ordersMap.set(req.params.id, order);
    return res.json(order);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const allOrders = await listOrders();
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
