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

        const offsetInFile = fileData.readUInt32LE(eOff + 12);
        const recType = fileData.readUInt32LE(eOff + 4);
        if (offsetInFile && offsetInFile < fileData.length) {
            let sEnd = offsetInFile;
            while (sEnd < fileData.length && fileData[sEnd] !== 0) sEnd++;
            const txt = fileData.slice(offsetInFile, sEnd).toString("utf8");
            if (!records.has(recType)) records.set(recType, []);
            records.get(recType).push(txt);
        }
    }
    blockOff = nextBlock;
}

// Check what types exist and look for 102
for (const [type, arr] of records) {
    if (type >= 10 && type < 2000) {
        if (arr.some(r => r.includes("102") || r.includes("63"))) {
            console.log(`Type ${type} contains 102 or 63. Sample: ${arr.find(a => a.includes("102") || a.includes("63"))} | TOTAL: ${arr.length}`);
        }
    }
}
