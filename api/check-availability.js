import { getApps, initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

if (!getApps().length) {
  initializeApp({
    credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
  });
}
const db = getFirestore();

function datesOverlap(inA, outA, inB, outB) {
  return new Date(inA) < new Date(outB) && new Date(inB) < new Date(outA);
}

// Checks whether a specific room at a specific hotel is free for a given
// date range. Runs with Admin SDK privileges so it can look across every
// guest's bookings for that hotel — something the browser is deliberately
// NOT allowed to do directly (Firestore Rules only let a guest read their
// own bookings, to keep other guests' details private).
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { hotelId, roomName, checkin, checkout } = req.body || {};
  if (!hotelId || !roomName || !checkin || !checkout) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const snap = await db.collection('bookings')
      .where('hotelId', '==', hotelId)
      .where('status', '==', 'confirmed')
      .get();

    let clash = false;
    snap.forEach(doc => {
      const b = doc.data();
      if (b.roomName === roomName && datesOverlap(checkin, checkout, b.checkin, b.checkout)) {
        clash = true;
      }
    });

    return res.status(200).json({ available: !clash });
  } catch (err) {
    return res.status(500).json({ error: 'Could not check availability' });
  }
}
