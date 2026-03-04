import * as fs from 'fs';
import { parseOCDCourseData } from './ocd-course-parser';

const fileData = fs.readFileSync('e2e/test.ocd');
const parsed = parseOCDCourseData(fileData);

const allControls = parsed.controls.map(c => c.id);
console.log("Controls Length:", parsed.controls.length);
console.log("Has 79:", allControls.includes('79'));
console.log("Has S1:", allControls.includes('S1'));
console.log("Has M1:", allControls.includes('M1'));

console.log("79:", parsed.controls.find(c => c.id === '79'));
console.log("65:", parsed.controls.find(c => c.id === '65'));
console.log("S1:", parsed.controls.find(c => c.id === 'S1'));
