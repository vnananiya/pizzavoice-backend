const express = require('express');
const { VoiceResponse, MessagingResponse } = require('twilio').twiml;
const twilio = require('twilio');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const orders = new Map();
const calls = new Map();

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

function generateAIResponse(text, state) {
  const lower = text.toLowerCase();
  if (!state.stage || /^hi|hey|hello|start|order/i.test(text)) {
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
  if (/price|cost|how much/i.test(text)) return "Pizzas start at \$13.99. Specialty \$16.99-\$17.99. Sides from \$1.99. What would you like?";
  if (/hour|open|close|when|address|where/i.test(text)) return "We're at 142 Broadway, New York NY 10013. Open 10AM-midnight daily!";
  return "I didn't catch that. Say what you'd like to order, or ask for our menu.";
}

app.post('/voice', (req, res) => {
  const callSid = req.body.CallSid || 'demo-' + Date.now();
  const speechResult = req.body.SpeechResult || '';
  const state = calls.get(callSid) || { stage: 'greeting', order: [], cartTotal: 0, deal: null };
  let response = generateAIResponse(speechResult, state);
  calls.set(callSid, state);

  if (state.stage === 'confirming' && /yes|yeah|yep|confirm|do it|place/i.test(speechResult)) {
    const orderNum = generateOrderNumber();
    let total = state.cartTotal;
    if (state.deal) {
      if (state.deal.type === 'percent') total = total * (1 - state.deal.value / 100);
      else if (state.deal.type === 'fixed') total = total - state.deal.value;
    }
    const tax = total * 0.085;
    const finalTotal = total + tax;
    const order = {
      id: 'ord-' + Date.now(), orderNumber: orderNum,
      customerPhone: req.body.From || 'Unknown',
      items: state.order, subtotal: state.cartTotal, tax, total: finalTotal,
      deal: state.deal?.desc || null, status: 'received', callSid,
      createdAt: new Date().toISOString(),
    };
    orders.set(orderNum, order);
    response = `Perfect! Order ${orderNum} confirmed! Total: ${fmt(finalTotal)}. You'll get a text receipt shortly. Thanks for calling Domino's!`;
    state.stage = 'confirmed';

    if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
      const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      const itemList = state.order.map(i => `${i.qty > 1 ? i.qty + 'x ' : ''}${i.name}`).join(', ');
      client.messages.create({
        body: `🍕 Domino's Order ${orderNum} Confirmed!\n\n${itemList}\n\nSubtotal: ${fmt(state.cartTotal)}\nTax: ${fmt(tax)}\nTotal: ${fmt(finalTotal)}\n\nEst. wait: 25-35 min\nThank you!`,
        from: process.env.TWILIO_PHONE_NUMBER, to: req.body.From,
      }).catch(err => console.log('SMS error:', err.message));
    }
    state.order = []; state.cartTotal = 0;
  }

  const twiml = new VoiceResponse();
  twiml.say({ voice: 'alice', bargeIn: true }, response);
  if (state.stage !== 'confirmed') {
    const g = twiml.gather({ input: 'speech', action: '/voice', method: 'POST', language: 'en-US', bargeIn: true, timeout: 6 });
    g.say({ voice: 'alice' }, 'Go ahead.');
  } else {
    twiml.say({ voice: 'alice' }, 'Goodbye!');
  }
  res.type('text/xml').send(twiml.toString());
});

app.post('/sms', (req, res) => {
  const twiml = new MessagingResponse();
  twiml.message('Thanks for texting Domino\'s! Call ' + process.env.TWILIO_PHONE_NUMBER + ' to order. Open 10AM-midnight!');
  res.type('text/xml').send(twiml.toString());
});

app.get('/api/orders', (req, res) => {
  res.json(Array.from(orders.values()).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
});

app.get('/api/orders/:id', (req, res) => {
  const o = orders.get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Not found' });
  res.json(o);
});

app.patch('/api/orders/:id/status', (req, res) => {
  const o = orders.get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Not found' });
  o.status = req.body.status;
  res.json(o);
});

app.get('/api/stats', (req, res) => {
  const today = new Date().toDateString();
  const todayOrders = Array.from(orders.values()).filter(o => new Date(o.createdAt).toDateString() === today);
  res.json({ ordersToday: todayOrders.length, revenueToday: todayOrders.reduce((s, o) => s + o.total, 0) });
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'PizzaVoice AI', time: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('PizzaVoice AI running on port ' + PORT);
});
