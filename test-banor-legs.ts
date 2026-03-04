import * as fs from 'fs';

const filePath = '/home/marcus/Downloads/Banor 4 oktober ALLA KLASSER.ocd';
const fileData = fs.readFileSync(filePath);
const objIndexOffset = fileData.readUInt32LE(12);

function ocadCoordToMm(coord: number) {
    return Number((coord / 25600).toFixed(2));
}

let blockOff = objIndexOffset;

function extractLegs() {
    while (blockOff > 0 && blockOff < fileData.length) {
        const nextBlock = fileData.readUInt32LE(blockOff);
        for (let i = 0; i < 256; i++) {
            const eOff = blockOff + 4 + i * 32;
            if (eOff + 32 > fileData.length) break;
            const filePos = fileData.readUInt32LE(eOff + 16);
            if (!filePos) continue;

            const sym = fileData.readInt32LE(eOff + 24);
            const objType = fileData.readUInt8(eOff + 28);

            if (sym === 705000 && objType === 2) {
                const dump = fileData.slice(filePos + 64, Math.min(fileData.length, filePos + 256));
                const txt = dump.toString("utf16le").replace(/\0/g, "");

                if (txt.includes('FIN1')) {
                    const nItem = fileData.readUInt32LE(filePos + 44);
                    console.log(`Leg to FIN1: Items=${nItem}, txt preview: ${txt.substring(0, 40).replace(/\n|\r/g, " ")}`);
                    let coordStart = filePos + 56 + 8; // header is 56 bytes, then 8 bytes padding? Wait, let me check readNItems offsets.
                    // Wait, obj header is 32 bytes! nItem is at offset 32? No, filePos + 44 is nItem? Yes.
                    // Actual coordinates start at pos + 32 + ? No, OBJ_HEADER_SIZE is 56 in OCAD 12.
                    const coordsPos = filePos + 56; // no wait, coords start right at pos + 64 or 56?
                    // wait, my `readCoords` says: offset = pos + 56 + 8? No, readCoords says: 
                    // `const offset = pos + 56;` wait. `pos + 56` is rawX. 
                    // `pos + 64` is start of points!
                    for (let k = 0; k < Math.min(nItem, 5); k++) {
                        const ptX = fileData.readInt32LE(filePos + 64 + k * 8);
                        const ptY = fileData.readInt32LE(filePos + 68 + k * 8);
                        console.log(`  Pt[${k}]: ${ocadCoordToMm(ptX)}, ${ocadCoordToMm(ptY)}`);
                    }
                }
            }
        }
        blockOff = nextBlock;
    }
}
extractLegs();
