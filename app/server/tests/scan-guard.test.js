const { detectBroadScan, getCommandFromHookInput } = require('../pipeline/hooks/scan-guard');

describe('detectBroadScan', () => {
  test.each([
    'find /',
    'find /c/odoo -name models.py',
    'find C:\\ -name odoo-bin',
    'find odoo-envs/cwt/src -name sale_order.py',
    'grep -r pattern odoo-envs',
    'powershell -NoProfile -Command "Get-ChildItem -Recurse C:\\"',
    "bash -lc 'find / -name secrets'",
    "rtk bash -lc 'find / -name secrets'",
    'rtk powershell -Command "rg -r pattern C:\\"',
    'find.exe / -name secrets',
  ])('blocks %s', command => {
    expect(detectBroadScan(command).blocked).toBe(true);
  });

  test.each([
    'find . -name "*.py"',
    'find ./idx_sale_note -name models.py',
    'grep -rn "compute" ./idx_sale_note',
    'powershell -NoProfile -Command "Get-ChildItem -Recurse .\\app"',
    "rtk bash -lc 'find . -name models.py'",
    'tail -c 8192 "/c/odoo-envs/cwt/odoo.log"',
  ])('allows %s', command => {
    expect(detectBroadScan(command).blocked).toBe(false);
  });
});

describe('getCommandFromHookInput', () => {
  test.each([
    [{ tool_input: { command: 'find /' } }, 'find /'],
    [{ tool_input: { input: { command: 'find /' } } }, 'find /'],
    [{ input: { command: 'find /' } }, 'find /'],
    [{ arguments: { command: 'find /' } }, 'find /'],
    [{ command: 'find /' }, 'find /'],
  ])('reads a command from a supported hook payload', (input, expected) => {
    expect(getCommandFromHookInput(input)).toBe(expected);
  });
});
