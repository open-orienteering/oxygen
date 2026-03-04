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

        const filePos = fileData.readUInt32LE(eOff); // Wait, OCAD 11/12 String Index block format?
        // Wait, what's OCAD 11/12 format exactly?
        const offsetInFile = fileData.readUInt32LE(eOff + 12);
        const recType = fileData.readUInt32LE(eOff + 4);
        const objIndex = fileData.readUInt32LE(eOff + 8);
        const size = fileData.readUInt32LE(eOff);

        if (offsetInFile > 0 && offsetInFile < fileData.length) {
            let sEnd = offsetInFile;
            while (sEnd < fileData.length && fileData[sEnd] !== 0) sEnd++;
            const txt = fileData.slice(offsetInFile, sEnd).toString("utf8");
            if (!records.has(recType)) records.set(recType, []);
            records.get(recType).push(txt);
        }
    }
    blockOff = nextBlock;
}

const courses = records.get(136); // Based on type 136? Let's print type 136 and 144
if (courses) {
    for (const c of courses) {
        if (c.startsWith("1\t")) {
            console.log("FROM STRING INDEX:", c);
        }
    }
} else {
    console.log("No courses in type 136 string index?");
}
