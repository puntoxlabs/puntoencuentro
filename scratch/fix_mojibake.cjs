const fs = require('fs');

const headFile = fs.readFileSync('scratch/head_service.ts', 'utf8');
const currFile = fs.readFileSync('src/services/encuentrosService.ts', 'utf8');

const headLines = headFile.split('\n');
const currLines = currFile.split('\n');

const mojibakeRegex = /[ÃÂâ├Ô]/;

let fixedCount = 0;

for (let i = 0; i < currLines.length; i++) {
  if (mojibakeRegex.test(currLines[i])) {
    // Find the equivalent line in headLines based on some context or just matching a simplified version
    // Since the mojibake only affected specific strings, and the lines are structurally identical:
    
    // Attempt to find the closest match in headLines (in case line numbers shifted slightly)
    let bestMatch = null;
    let minDistance = Infinity;
    
    // We expect the line to be within +/- 50 lines due to previous injections
    const searchStart = 0;
    const searchEnd = headLines.length - 1;
    
    for (let j = searchStart; j <= searchEnd; j++) {
      if (!mojibakeRegex.test(headLines[j])) {
        // Strip out the mojibake characters and see if the rest of the string matches
        const currClean = currLines[i].replace(/[ÃÂâ├Ô]/g, '').trim();
        const headClean = headLines[j].replace(/[áéíóúÁÉÍÓÚñÑ—]/g, '').trim();
        
        if (currClean === headClean && currClean.length > 5) {
          bestMatch = headLines[j];
          break;
        }
      }
    }
    
    if (bestMatch !== null) {
      currLines[i] = bestMatch;
      fixedCount++;
    } else {
      console.log('Could not find match for:', currLines[i].trim());
    }
  }
}

console.log(`Fixed ${fixedCount} lines.`);
fs.writeFileSync('src/services/encuentrosService.ts', currLines.join('\n'), 'utf8');

