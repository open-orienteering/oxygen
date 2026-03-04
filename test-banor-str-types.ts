import * as fs from 'fs';

const filePath = '/home/marcus/Downloads/Banor 4 oktober ALLA KLASSER.ocd';
const fileData = fs.readFileSync(filePath);
const stringParamIndexOff = fileData.readUInt32LE(20);

let blockOff = stringParamIndexOff;
const records = new Map<number, string[]>();

while (blockOff > 0 && blockOff < fileData.length) {
    const nextBlock = fileData.readUInt32LE(blockOff);
    for (let i = 0; i < 256; i++) {
        const eOff = blockOff + 4 + i * 16; // String blocks are 16 bytes per entry in OCAD 11/12! wait, OCAD 12 string index entry is 16 bytes? Let me check my parser.
        // wait, StringIndexEntry is length 16:
        // readUInt32LE(pos), readUInt32LE(pos+4)(type), readUInt32LE(pos+8)(subtype), filePos=readUInt32LE(pos+12)
        // No wait, in Ocad 12, String Index is:
        const filePos = fileData.readUInt32LE(eOff + 8);
        const objType = fileData.readInt32LE(eOff + 4);
        // wait, let's use the actual reading snippet:
        // recType = fileData.readUInt32LE(entryOff + 4);
        // objIndex = fileData.readUInt32LE(entryOff + 8); // wait, offset 8 is objIndex?
        // In my current parser, it's:
        // const recType = fileData.readUInt32LE(entryOff + 4);
        // const objIndex = fileData.readUInt32LE(entryOff + 8);
        // const filePos = fileData.readUInt32LE(entryOff + 12);
        // string len = fileData.readUInt32LE(entryOff) ? No, let's just use my parser logic!
        if (eOff + 16 > fileData.length) break;

        const offsetInFile = fileData.readUInt32LE(eOff + 12);
        const recType = fileData.readUInt32LE(eOff + 4);
        const size = fileData.readUInt32LE(eOff); // length? No, size is at +0?
        if (offsetInFile && offsetInFile < fileData.length) {
            // Strings are technically null terminated but let's read up to 1000 chars
            let sEnd = offsetInFile;
            while (sEnd < fileData.length && fileData[sEnd] !== 0) sEnd++;
            const txt = fileData.slice(offsetInFile, sEnd).toString("utf8");
            if (!records.has(recType)) records.set(recType, []);
            records.get(recType).push(txt);
        }
    }
    blockOff = nextBlock;
}

for (const [type, arr] of records) {
    if (type >= 10 && type < 2000) { // filter out random ones
        console.log(`Type ${type} has ${arr.length} records.`);
        if (type === 144) console.log("Example 144:", arr[0]); // classes?
        if (type === 136) console.log("Example 136:", arr[0]); // courses?
        if (arr.some(r => r.includes("sSTA1"))) {
            console.log(`Type ${type} CONTAINS COURSES:`, arr[0]);
        }
    }
}
