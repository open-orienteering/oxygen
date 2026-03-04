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
        const size = fileData.readUInt32LE(eOff);
        if (offsetInFile && offsetInFile < fileData.length) {
            let sEnd = offsetInFile;
            while (sEnd < fileData.length && fileData[sEnd] !== 0) sEnd++;
            const txt = fileData.slice(offsetInFile, sEnd).toString("utf8");
            if (!records.has(recType)) records.set(recType, []);
            records.get(recType)?.push(txt);
        }
    }
    blockOff = nextBlock;
}

console.log("Types found:", [...records.keys()].join(", "));

for (const [type, arr] of records) {
    if (arr.some(r => r.includes("sSTA1"))) {
        console.log(`\n\n=== Type ${type} CONTAINS COURSES ===`);
        console.log(arr[0].replace(/\n|\r|\t/g, " | "));
    }
}
