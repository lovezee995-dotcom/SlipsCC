require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const axios = require('axios');
const FormData = require('form-data');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const serviceAccount = require('.//serviceAccountKey.json');

// 1. เชื่อมต่อฐานข้อมูล Firebase Firestore
initializeApp({
  credential: cert(serviceAccount)
});
const db = getFirestore();

const app = express();
app.use(express.json());

// ตั้งค่า SlipOK
const SLIPOK_BRANCH_ID = '79221';
const SLIPOK_API_KEY = 'SLIPOKTBZZCQX';

// 2. จุดรับข้อมูล Webhook จาก LINE
app.post('/webhook', async (req, res) => {
  res.status(200).send('OK');

  try {
    const events = req.body.events;
    const botDestination = req.body.destination;

    if (!botDestination || !events || events.length === 0) return;

    console.log(`\n-----------------------------------------`);
    console.log(`🔔 [Step 1] มีข้อความเข้าที่ห้อง Destination: "${botDestination}"`);

    const allStores = await db.collection('stores').get();
    let storeDoc = null;

    allStores.forEach(doc => {
      const data = doc.data();
      if (data.destination && data.destination.trim() === botDestination.trim()) {
        storeDoc = doc;
      }
    });

    if (!storeDoc) {
      console.log(`⚠️ [Step 2] หาห้องไม่เจอใน Firebase สำหรับ Destination นี้`);
      return;
    }

    const storeData = storeDoc.data();
    const storeId = storeDoc.id;
    console.log(`✅ [Step 2] เจอข้อมูลห้อง: "${storeData.storeName}" (ID: ${storeId})`);

    const cleanToken = (storeData.channelAccessToken || '').trim();
    const cleanSecret = (storeData.channelSecret || '').trim();

    // ปรับการสร้าง MessagingApiClient ตาม LINE SDK เวอร์ชันใหม่
    const dynamicClient = new line.messagingApi.MessagingApiClient({
      channelAccessToken: cleanToken
    });

    for (const event of events) {
      console.log(`📩 [Step 3] ประเภทข้อความ: ${event.type} (${event.message ? event.message.type : 'ไม่มี'})`);
      
      if (event.type === 'message' && event.message.type === 'image') {
        await handleSlipCheck(event, dynamicClient, storeId, storeData);
      } else if (event.type === 'message' && event.message.type === 'text') {
        await dynamicClient.replyMessage({
          replyToken: event.replyToken,
          messages: [{
            type: 'เทส',
            text: `แอดมาแล้ว รอสักครู่ค้าบ`
          }]
        });
        console.log(`✅ ตอบกลับข้อความทดสอบสำเร็จ!`);
      }
    }
  } catch (error) {
    console.error('❌ Webhook Error:', error);
  }
});

// 3. ฟังก์ชันตรวจสลิป เช็กบัญชีผู้รับ และเช็กสลิปซ้ำ
async function handleSlipCheck(event, client, storeId, storeData) {
  const replyToken = event.replyToken;
  const messageId = event.message.id;

  try {
    console.log(`⏳ [Step 4] กำลังดาวน์โหลดรูปภาพสลิปจาก LINE...`);
    
    // ดึงรูปภาพผ่าน LINE Content API
    const imageResponse = await axios.get(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
      headers: {
        'Authorization': `Bearer ${(storeData.channelAccessToken || '').trim()}`
      },
      responseType: 'arraybuffer'
    });
    const imageBuffer = Buffer.from(imageResponse.data, 'binary');
    console.log(`✅ [Step 4] ดาวน์โหลดรูปสำเร็จ! (${imageBuffer.length} bytes)`);

    console.log(`⏳ [Step 5] กำลังส่งรูปไปตรวจกับ SlipOK...`);
    const form = new FormData();
    form.append('files', imageBuffer, { filename: 'slip.jpg' });

    const slipResponse = await axios.post(`https://api.slipok.com/api/line/apikey/${SLIPOK_BRANCH_ID}`, form, {
      headers: {
        'x-authorization': SLIPOK_API_KEY,
        ...form.getHeaders()
      }
    });

    const slipData = slipResponse.data;
    console.log(`✅ [Step 5] SlipOK ตอบกลับมาแล้ว! สถานะ: ${slipData.success}`);

    if (!slipData.success) {
      await client.replyMessage({
        replyToken: replyToken,
        messages: [{ type: 'text', text: `❌ สลิปไม่ถูกต้อง หรือตรวจไม่พบข้อมูล` }]
      });
      return;
    }

    const data = slipData.data;
    const transRef = data.transRef;
    const receiverName = data.receiver?.displayName || data.receiver?.name || '';
    const receiverAccount = data.receiver?.account?.value || '';

    console.log(`📄 ข้อมูลผู้รับในสลิป -> ชื่อ: "${receiverName}" | เลขบัญชี: "${receiverAccount}"`);

    // 4. เช็กว่าเป็นบัญชีของร้านนี้จริงหรือไม่ (รองรับทั้งแบบบัญชีเดียวและหลายบัญชี)
    const expectedAccounts = storeData.storeAccount; 
    if (expectedAccounts) {
      // แปลงข้อมูลให้เป็นอาเรย์ (รองรับทั้งแบบข้อมูลเก่าที่เป็น string และแบบใหม่ที่เป็น array)
      const accountList = Array.isArray(expectedAccounts) ? expectedAccounts : [expectedAccounts];
      
      const cleanSlipAcc = receiverAccount.replace(/[^0-9]/g, '');
      
      let isMatch = false;
      for (const acc of accountList) {
        const cleanExpectedAcc = String(acc).replace(/[^0-9]/g, '');
        if (cleanExpectedAcc !== '' && cleanSlipAcc.includes(cleanExpectedAcc)) {
          isMatch = true;
          break;
        }
        if (receiverName.includes(String(acc))) {
          isMatch = true;
          break;
        }
      }

      if (!isMatch) {
        console.log(`❌ บัญชีผู้รับไม่ตรงกับบัญชีที่ตั้งไว้ในร้านนี้`);
        await client.replyMessage({
          replyToken: replyToken,
          messages: [{
            type: 'text',
            text: `❌ สลิปไม่ถูกต้อง: บัญชีผู้รับไม่ตรงกับของทางร้าน!\n(ผู้รับในสลิป: ${receiverName})`
          }]
        });
        return;
      }
    }

    // 5. เช็กสลิปซ้ำ
    const slipRef = db.collection('stores').doc(storeId).collection('used_slips').doc(transRef);
    const slipDoc = await slipRef.get();

    if (slipDoc.exists) {
      console.log(`⚠️ พบสลิปซ้ำ! เลขที่รายการ: ${transRef}`);
      await client.replyMessage({
        replyToken: replyToken,
        messages: [{ type: 'text', text: `⚠️ แจ้งเตือนสลิปซ้ำ!\nสลิปนี้เคยถูกส่งใช้งานไปแล้ว\n(เลขที่รายการ: ${transRef})` }]
      });
      return;
    }

    await slipRef.set({
      usedAt: FieldValue.serverTimestamp(),
      amount: data.amount,
      sender: data.sender?.displayName || data.sender?.name || 'ไม่ระบุชื่อ',
      storeName: storeData.storeName || storeId
    });

    console.log(`🎉 [Step 6] ตรวจสอบผ่านทุกขั้นตอน! กำลังส่งข้อความตอบกลับ...`);
    // ตอบกลับเมื่อสลิปถูกต้อง (แสดงชื่อผู้รับแทนผู้โอน)
    await client.replyMessage({
      replyToken: replyToken,
      messages: [{
        type: 'text',
        text: `✅ สลิปถูกต้อง (${storeData.storeName || 'ตรวจสอบสำเร็จ'})\n💰 ยอดเงิน: ${data.amount} บาท\n🏦 ผู้รับเงิน: ${receiverName}`
      }]
    });

  } catch (error) {
    const errDetail = error.response ? JSON.stringify(error.response.data) : error.message;
    console.error('❌ Slip Check Error:', errDetail);
    
    await client.replyMessage({
      replyToken: replyToken,
      messages: [{ type: 'text', text: `❌ เกิดข้อผิดพลาดในการตรวจสลิป` }]
    });
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 เซิร์ฟเวอร์รันเรียบร้อยแล้วที่พอร์ต ${PORT}`);
});