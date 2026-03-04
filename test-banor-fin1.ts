import * as fs from 'fs';

const filePath = '/home/marcus/Downloads/Banor 4 oktober ALLA KLASSER.ocd';
const fileData = fs.readFileSync(filePath);
const objIndexOffset = fileData.readUInt32LE(12);

let blockOff = objIndexOffset;

function dumpLabels() {
    while (blockOff > 0 && blockOff < fileData.length) {
        const nextBlock = fileData.readUInt32LE(blockOff);
        for (let i = 0; i < 256; i++) {
            const eOff = blockOff + 4 + i * 32;
            if (eOff + 32 > fileData.length) break;
            const filePos = fileData.readUInt32LE(eOff + 16);
            if (!filePos) continue;

            const sym = fileData.readInt32LE(eOff + 24);
            const objType = fileData.readUInt8(eOff + 28);

            if (sym >= 700000 && sym <= 800000 && objType === 1) {
                const dump = fileData.slice(filePos + 64, Math.min(fileData.length, filePos + 512));
                const txt = dump.toString("utf16le").replace(/\0/g, "");

                if (txt.includes('FIN1')) {
                    console.log(`FIN1 is in Sym: ${sym}, txt: ${txt.substring(0, 100).replace(/\n|\r/g, " ")}`);
                }
            }
        }
        blockOff = nextBlock;
    }
}
dumpLabels();
