const fs = require('fs');
let c = fs.readFileSync('src/services/encuentrosService.ts', 'utf8');

const map = {
  'NecesitÃƒÂ¡s': 'NecesitÃ¡s',
  'sesiÃƒÂ³n': 'sesiÃ³n',
  'RevisÃƒÂ¡': 'RevisÃ¡',
  'AgregÃƒÂ¡': 'AgregÃ¡',
  'PodÃƒÂ©s': 'PodÃ©s',
  'opciÃƒÂ³n': 'opciÃ³n',
  'IndicÃƒÂ¡': 'IndicÃ¡',
  'reuniÃƒÂ³n': 'reuniÃ³n',
  'invitaciÃƒÂ³n': 'invitaciÃ³n',
  'diseÃƒÂ±o': 'diseÃ±o',
  'tenÃƒÂ©s': 'tenÃ©s',
  'IntentÃƒÂ¡': 'IntentÃ¡',
  'Ã¢â‚¬â€': 'â€”',
  'vacÃƒÂ­os': 'vacÃ­os',
  'ÃƒÅ¡sese': 'Ãšsese',
  'mÃƒÂ©todo': 'mÃ©todo',
  'fallarÃƒÂ¡': 'fallarÃ¡',
  'anÃƒÂ³nimos': 'anÃ³nimos',
  'estÃƒÂ¡': 'estÃ¡',
  'cancelaciÃƒÂ³n': 'cancelaciÃ³n',
  'coordinaciÃƒÂ³n': 'coordinaciÃ³n'
};

for (const [bad, good] of Object.entries(map)) {
  c = c.split(bad).join(good);
}

fs.writeFileSync('src/services/encuentrosService.ts', c, 'utf8');
console.log('Replaced mojibake with correct chars.');
