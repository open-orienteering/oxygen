import * as fs from 'fs';

const OBJ_HEADER_SIZE = 56;
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
        const len = fileData.readUInt32LE(eOff + 20);
        const sym = fileData.readInt32LE(eOff + 24);
        const objType = fileData.readUInt8(eOff + 28);
        
        if (filePos && sym === 702000) {
            const nItem = fileData.readUInt16LE(filePos + 12);
            const nText = fileData.readUInt16LE(filePos + 14);
            
            const nItemUsed = nItem > 0 ? nItem : 1;
            const textStart = filePos + OBJ_HEADER_SIZE + nItemUsed * 8;
            
            let txt = "";
            if (nText > 0 && textStart + nText * 2 <= fileData.length) {
                txt = fileData.slice(textStart, textStart + nText * 2).toString("utf16le").replace(/\0/g, "");
            }
            
            console.log(`Sym: 702000, nItem: ${nItem}, nText: ${nText}, text: "${txt}"`);
            found++;
        }
    }
    blockOff = nextBlock;
}
console.log(`Total 702000 found: ${found}`);
