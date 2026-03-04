import * as fs from 'fs';

const fileData = fs.readFileSync('e2e/test.ocd');
const objIndexOffset = fileData.readUInt32LE(12);

let blockOff = objIndexOffset;
let found = 0;
while (blockOff > 0 && blockOff < fileData.length) {
    const nextBlock = fileData.readUInt32LE(blockOff);
    for (let i = 0; i < 256; i++) {
        const eOff = blockOff + 4 + i * 32;
        if (eOff + 32 > fileData.length) break;
        const filePos = fileData.readUInt32LE(eOff + 16);
        const sym = fileData.readInt32LE(eOff + 24);
        
        if (filePos && sym === 702000) {
            const rawX = fileData.readInt32LE(filePos + 56);
            const rawY = fileData.readInt32LE(filePos + 60);
            
            console.log(`Sym: ${sym}`);
            console.log(`  Raw: X=${rawX}, Y=${rawY}`);
            console.log(`  >> 8: X=${rawX >> 8}, Y=${rawY >> 8} (${(rawX>>8)/100} mm, ${(rawY>>8)/100} mm)`);
            console.log(`  Current code: X=${((rawX>>8)<<8)/100} mm, Y=${((rawY>>8)<<8)/100} mm`);
            found++;
            if (found > 3) process.exit(0);
        }
    }
    blockOff = nextBlock;
}
