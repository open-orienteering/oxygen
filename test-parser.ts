import * as fs from 'fs';
import { parseOCDCourseData } from './packages/api/src/ocd-course-parser.ts';

async function main() {
    const fileData = fs.readFileSync('/home/marcus/Downloads/Banor 4 oktober ALLA KLASSER.ocd');
    const result = parseOCDCourseData(fileData);
    console.log("Control 79:", result.controls.find(c => c.id === '79'));
    console.log("Starts:", result.starts);
    console.log("Finishes:", result.finishes);
}

main().catch(console.error);
