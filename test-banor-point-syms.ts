import * as fs from 'fs';

const filePath = '/home/marcus/Downloads/Banor 4 oktober ALLA KLASSER.ocd';
const fileData = fs.readFileSync(filePath);
const objIndexOffset = fileData.readUInt32LE(12);

let blockOff = objIndexOffset;

function dumpAllPointSyms() {
    const symCounts = new Map<number, number>();
    while (blockOff > 0 && blockOff < fileData.length) {
        const nextBlock = fileData.readUInt32LE(blockOff);
        for (let i = 0; i < 256; i++) {
            const eOff = blockOff + 4 + i * 32;
            if (eOff + 32 > fileData.length) break;
            const filePos = fileData.readUInt32LE(eOff + 16);
            if (!filePos) continue;

            const sym = fileData.readInt32LE(eOff + 24);
            const objType = fileData.readUInt8(eOff + 28);

            if (objType === 1 && sym >= 700000 && sym < 800000) { // POINT objects
                symCounts.set(sym, (symCounts.get(sym) || 0) + 1);
            }
        }
        blockOff = nextBlock;
    }
    console.log("Point symbols in 700xxx block:", Object.fromEntries(symCounts));
}
dumpAllPointSyms();
