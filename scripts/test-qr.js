const QRCode = require('qrcode');

async function testQR() {
  try {
    const originalBytes = Buffer.from([0x00, 0x01, 0x1f, 0x20, 0x7f, 0x80, 0x81, 0xfe, 0xff]);
    const latin1String = originalBytes.toString('latin1');
    
    // We can use create to inspect the segments
    const qr = QRCode.create([{ data: originalBytes, mode: 'byte' }], { errorCorrectionLevel: 'L' });
    const segments = qr.segments;
    console.log("Segment mode:", segments[0].mode.id);
    console.log("Segment data length:", segments[0].data.length);

    console.log("Byte representation passes qrcode module construction.");

  } catch (e) {
    console.error(e);
  }
}

testQR();
