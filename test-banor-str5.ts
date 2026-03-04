import * as fs from 'fs';

const filePath = '/home/marcus/Downloads/Banor 4 oktober ALLA KLASSER.ocd';
const fileData = fs.readFileSync(filePath);
const stringParamIndexOff = fileData.readUInt32LE(20);

let blockOff = stringParamIndexOff;
const activeCourseDefs: string[] = [];

const seenBlocks = new Set<number>();

while (blockOff > 0 && blockOff < fileData.length) {
    if (seenBlocks.has(blockOff)) break;
    seenBlocks.add(blockOff);

    const nextBlock = fileData.readUInt32LE(blockOff);

    for (let i = 0; i < 256; i++) {
        const eOff = blockOff + 4 + i * 16;
        if (eOff + 16 > fileData.length) break;

        // Size could be 0, filePos could be 0 for empty entries
        const filePos = fileData.readUInt32LE(eOff); // actually OCAD 12 string array is filePos?
        const sizeOrLen = fileData.readUInt32LE(eOff + 4);
        const recType = fileData.readUInt32LE(eOff + 8);
        const objIndex = fileData.readUInt32LE(eOff + 12);

        // Wait, what's exactly the OCAD 12 string index entry?
        // OpenOrienteeringMapper says: for OCAD >= 11:
        // entry = { int32 record_type, int32 obj_index, int32 pos, int32 length }?
        // Let's test this layout:
        const t1 = fileData.readInt32LE(eOff);   // type?
        const t2 = fileData.readInt32LE(eOff + 4); // obj_index?
        const t3 = fileData.readInt32LE(eOff + 8); // file_pos?
        const t4 = fileData.readInt32LE(eOff + 12);// size?

        if (t3 > 0 && t3 < fileData.length && t4 > 0 && t4 < 100000 && t1 === 136) {
            // 136 is Course Data usually
            let txt = fileData.slice(t3, t3 + t4).toString('utf8');
            activeCourseDefs.push(txt.replace(/\n|\r|\t/g, " | "));
        }
    }
    blockOff = nextBlock;
}

if (activeCourseDefs.length > 0) {
    console.log(`Found ${activeCourseDefs.length} ACTIVE courses from exact block parsing!`);
    activeCourseDefs.filter(c => c.startsWith("1 | ")).forEach(c => console.log(c));
} else {
    // try alternative
    console.log("No courses found. Try alternative layout.");
}

