import * as fs from 'fs';

const filePath = '/home/marcus/Downloads/Banor 4 oktober ALLA KLASSER.ocd';
const fileData = fs.readFileSync(filePath);
const stringParamIndexOff = fileData.readUInt32LE(20);

let blockOff = stringParamIndexOff;
const records = new Map<number, string[]>();

let sanity = 0;
while (blockOff > 0 && blockOff < fileData.length && sanity++ < 100) {
    const nextBlock = fileData.readUInt32LE(blockOff);
    for (let i = 0; i < 256; i++) {
        const eOff = blockOff + 4 + i * 16;
        if (eOff + 16 > fileData.length) break;

        const size = fileData.readInt32LE(eOff);
        const type = fileData.readInt32LE(eOff + 4);
        const objIndex = fileData.readInt32LE(eOff + 8);
        const filePos = fileData.readInt32LE(eOff + 12);

        if (filePos > 0 && filePos < fileData.length && size > 0 && size < 100000 && type > 0) {
            const txt = fileData.slice(filePos, filePos + size).toString("utf8");
            if (!records.has(type)) records.set(type, []);
            records.get(type).push(txt);
        }
    }
    blockOff = nextBlock;
}

console.log("Found types:", [...records.keys()].join(", "));

for (const [t, arr] of records) {
    if (t === 136) { // course type? string type 136? Wait, usually Course setting data is in type 136? we will see
        for (const c of arr) {
            if (c.startsWith("1\t")) {
                console.log(`Type ${t} Course 1:`, c.substring(0, 150).replace(/\n|\r|\t/g, " | "));
            }
        }
    }
}
