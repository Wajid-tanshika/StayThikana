import crypto from 'crypto';
import { getApps, initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// Reuse the same Admin SDK connection across requests instead of
// reconnecting every time (Vercel keeps functions "warm" between calls).
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

  // The core security check: rebuild the signature ourselves using the
  // secret key. Only Razorpay could have produced a signature that matches,
  // so if it matches, the payment is real.
  const expectedSignature = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  if (expectedSignature !== razorpay_signature) {
    return res.status(400).json({ error: 'Payment verification failed' });
  }

  // Final safety net: re-check availability right before writing the
  // booking, in case two guests booked the same room within seconds of
  // each other. The client already checked this once, but a server-side
  // recheck closes that race-condition window. Because payment has
  // already gone through at this point, a clash here is flagged for a
  // manual refund rather than silently double-booking the room.
  function datesOverlap(inA, outA, inB, outB) {
    return new Date(inA) < new Date(outB) && new Date(inB) < new Date(outA);
  }
  try {
    const existing = await db.collection('bookings')
      .where('hotelId', '==', booking.hotelId)
      .where('status', '==', 'confirmed')
      .get();
    let clash = false;
    existing.forEach(doc => {
      const b = doc.data();
      if (b.roomName === booking.roomName && datesOverlap(booking.checkin, booking.checkout, b.checkin, b.checkout)) {
        clash = true;
      }
    });
    if (clash) {
      await db.collection('notifications').add({
        uid: booking.uid,
        message: `Sorry — ${booking.roomName} got booked by someone else moments before you. Your payment (${razorpay_payment_id}) will be refunded, contact support if you don't hear back soon.`,
        read: false,
        createdAt: Date.now()
      });
      return res.status(409).json({ error: 'Room was just booked by someone else. Your payment will be refunded — contact support with payment ID ' + razorpay_payment_id });
    }
  } catch (err) {
    // If the availability recheck itself fails, fall through and still
    // honor the payment rather than losing a valid booking over a glitch.
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
