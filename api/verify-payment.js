import crypto from 'crypto';
import { getApps, initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

if (!getApps().length) {
  initializeApp({
    credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
  });
}
const db = getFirestore();

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, booking } = req.body || {};
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !booking || !booking.uid) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const expectedSignature = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  if (expectedSignature !== razorpay_signature) {
    return res.status(400).json({ error: 'Payment verification failed' });
  }

  try {
    const bookingRef = await db.collection('bookings').add({
      uid: booking.uid,
      hotelId: booking.hotelId,
      hotelName: booking.hotelName,
      hotelImg: booking.hotelImg,
      city: booking.city,
      roomName: booking.roomName,
      checkin: booking.checkin,
      checkout: booking.checkout,
      amount: booking.amount,
      paymentId: razorpay_payment_id,
      orderId: razorpay_order_id,
      status: 'confirmed',
      createdAt: Date.now()
    });

    await db.collection('notifications').add({
      uid: booking.uid,
      message: `Booking confirmed at ${booking.hotelName} — ${booking.checkin} to ${booking.checkout}.`,
      read: false,
      createdAt: Date.now()
    });

    return res.status(200).json({ success: true, bookingId: bookingRef.id });
  } catch (err) {
    return res.status(500).json({ error: 'Payment verified but booking could not be saved — contact support' });
  }
}
