import * as fs from 'fs';

const filePath = '/home/marcus/Downloads/Banor 4 oktober ALLA KLASSER.ocd';
const fileData = fs.readFileSync(filePath);
const stringParamIndexOff = fileData.readUInt32LE(20);

let blockOff = stringParamIndexOff;
const records = new Map<number, string[]>();

while (blockOff > 0 && blockOff < fileData.length) {
    const nextBlock = fileData.readUInt32LE(blockOff);
    for (let i = 0; i < 256; i++) {
        const eOff = blockOff + 4 + i * 16;
        if (eOff + 16 > fileData.length) break;

        const filePos = fileData.readUInt32LE(eOff);
        const len = fileData.readUInt32LE(eOff + 4);
        const recType = fileData.readUInt32LE(eOff + 8);
        const objIndex = fileData.readUInt32LE(eOff + 12);

        if (filePos > 0 && filePos < fileData.length && len < 100000) {
            const txt = fileData.slice(filePos, filePos + len).toString("utf8");
            if (!records.has(recType)) records.set(recType, []);
            records.get(recType).push(txt);
        }
    }
    blockOff = nextBlock;
}

for (const [type, arr] of records) {
    if (type >= 10 && type <= 2000) {
        if (arr.some(r => r.includes("sSTA1") || r.includes("102") || r.includes("63"))) {
            console.log(`Type ${type}: Found match! Size: ${arr.length}. First: ${arr[0].substring(0, 100).replace(/\n|\r|\t/g, " | ")}`);
        }
    }
}
