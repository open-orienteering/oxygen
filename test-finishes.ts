import * as fs from 'fs';

const OBJ_HEADER_SIZE = 56;
const fileData = fs.readFileSync('e2e/test.ocd');
const objIndexOffset = fileData.readUInt32LE(12);

let blockOff = objIndexOffset;

function dumpFinishes() {
    let numFinishes = 0;
    while (blockOff > 0 && blockOff < fileData.length) {
        const nextBlock = fileData.readUInt32LE(blockOff);
        for (let i = 0; i < 256; i++) {
            const eOff = blockOff + 4 + i * 32;
            if (eOff + 32 > fileData.length) break;
            const filePos = fileData.readUInt32LE(eOff + 16);
            const sym = fileData.readInt32LE(eOff + 24);
            const objType = fileData.readUInt8(eOff + 28);

            if (filePos && sym === 706000) {
                numFinishes++;
                const rawX = fileData.readInt32LE(filePos + 56);
                const rawY = fileData.readInt32LE(filePos + 60);

                console.log(`Pos ${filePos}, Sym 706000: rawX=${rawX} rawY=${rawY} objType=${objType}`);
            }
        }
        blockOff = nextBlock;
    }
    console.log(`Total Finishes 706000: ${numFinishes}`);
}
dumpFinishes();
