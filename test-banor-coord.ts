import * as fs from 'fs';

const filePath = '/home/marcus/Downloads/Banor 4 oktober ALLA KLASSER.ocd';
const fileData = fs.readFileSync(filePath);
const objIndexOffset = fileData.readUInt32LE(12);

let blockOff = objIndexOffset;

function searchByCoordinate() {
    let un = 0;
    while (blockOff > 0 && blockOff < fileData.length) {
        const nextBlock = fileData.readUInt32LE(blockOff);
        for (let i = 0; i < 256; i++) {
            const eOff = blockOff + 4 + i * 32;
            if (eOff + 32 > fileData.length) break;
            const filePos = fileData.readUInt32LE(eOff + 16);
            if (!filePos || filePos + 64 > fileData.length) continue;

            const sym = fileData.readInt32LE(eOff + 24);
            const objType = fileData.readUInt8(eOff + 28);

            const rawX = fileData.readInt32LE(filePos + 56);
            const rawY = fileData.readInt32LE(filePos + 60);

            const xMm = rawX / 25600;
            const yMm = rawY / 25600;

            if (Math.abs(xMm - 57.2) < 5 && Math.abs(yMm - 166.9) < 5) {
                console.log(`Sym: ${sym}, Type: ${objType}, Pos: ${filePos}, X: ${xMm.toFixed(2)}, Y: ${yMm.toFixed(2)}`);
                const dump = fileData.slice(filePos + 64, Math.min(fileData.length, filePos + 256));
                const txt = dump.toString("utf16le").replace(/\0/g, "");
                console.log(`Text: ${txt.substring(0, 50).replace(/\n|\r/g, " ")}`);
            }
        }
        blockOff = nextBlock;
    }
}
searchByCoordinate();
