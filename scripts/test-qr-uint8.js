const QRCode = require('qrcode');

async function testQR() {
  try {
    const originalBytes = new Uint8Array([0x00, 0x01, 0x1f, 0x20, 0x7f, 0x80, 0x81, 0xfe, 0xff]);
    
    // Test passing Uint8Array directly
    const qr = QRCode.create([{ data: originalBytes, mode: 'byte' }], { errorCorrectionLevel: 'L' });
    const segments = qr.segments;
    console.log("Segment mode:", segments[0].mode.id);
    console.log("Segment data length:", segments[0].data.length);
    console.log("Segment original data type:", typeof segments[0].data, Array.isArray(segments[0].data) || segments[0].data instanceof Uint8Array ? 'Array/Uint8Array' : 'Other');
    console.log("Data:", segments[0].data);
    
    let isMatch = true;
    for(let i=0; i<originalBytes.length; i++) {
        if(segments[0].data[i] !== originalBytes[i]) isMatch = false;
    }
    console.log("Bytes match:", isMatch);

  } catch (e) {
    console.error(e);
  }
}

testQR();
