"""Independent seed-vector check. Python 3; pip install jsonschema for schema checks.
This is not an untrusted-import API, a world evaluator, or a general JCS library.
"""
from pathlib import Path
import hashlib
import json
import sys
from jsonschema import Draft202012Validator, FormatChecker

ROOT = Path(__file__).resolve().parent

def unique_object(pairs):
    result = {}
    for k, v in pairs:
        if k in result:
            raise ValueError(f'Duplicate JSON key: {k!r}')
        result[k] = v
    return result

def load(name):
    return json.loads((ROOT / name).read_text(encoding='utf8'), object_pairs_hook=unique_object,
                      parse_constant=lambda x: (_ for _ in ()).throw(ValueError(x)))

def canonical(x):
    if x is None: return 'null'
    if x is True: return 'true'
    if x is False: return 'false'
    if isinstance(x, int):
        if abs(x) > 2**53 - 1: raise ValueError('Unsafe integer')
        return str(x)
    if isinstance(x, str):
        x.encode('utf8', errors='strict')
        return json.dumps(x, ensure_ascii=False, separators=(',', ':'))
    if isinstance(x, list): return '[' + ','.join(canonical(a) for a in x) + ']'
    if isinstance(x, dict):
        keys = sorted(x, key=lambda k: k.encode('utf-16-be'))
        return '{' + ','.join(canonical(k) + ':' + canonical(x[k]) for k in keys) + '}'
    raise ValueError('Profile excludes this value type: ' + type(x).__name__)

def digest(b): return hashlib.sha256(b).hexdigest()

def main():
    doc = load('golden-vectors.json')
    schema = load('core-contracts.schema.json')
    Draft202012Validator.check_schema(schema)
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    by_name = {}
    positive_count = 0
    for v in doc['vectors']:
        if v['algorithm'] == 'sha256-raw':
            preimage = bytes.fromhex(v['payloadHex'])
        else:
            payload = canonical(v['payload']).encode('utf8')
            assert payload.hex() == v['canonicalUtf8Hex'], v['name']
            preimage = v['label'].encode('ascii') + b'\0' + payload
            assert preimage.hex() == v['preimageHex'], v['name']
        assert digest(preimage) == v['digest'], v['name']
        assert v['idPrefix'] + v['digest'] == v['expectedId'], v['name']
        if v['kind'] in ['claim', 'snapshot', 'revision']:
            validator.validate(v['payload']); positive_count += 1
        assert v['name'] not in by_name
        by_name[v['name']] = v
    for r in doc['relations']:
        assert r['kind'] == 'different'
        assert by_name[r['left']]['expectedId'] != by_name[r['right']]['expectedId']
    for case in doc['schemaNegativeCases']:
        assert list(validator.iter_errors(case['payload'])), case['name']
    last_path = ''
    for f in by_name['snapshot_lf']['payload']['files']:
        assert f['path'] > last_path; last_path = f['path']
        contents = (ROOT / 'fixture-payload' / f['path']).read_bytes()
        assert str(len(contents)) == f['byteLength']
        assert digest(contents) == f['sha256']
    print(json.dumps({'status':'passed','runtime':'Python '+sys.version.split()[0],
        'vectors':len(doc['vectors']),'schemaPositiveCases':positive_count,
        'schemaNegativeCases':len(doc['schemaNegativeCases']),
        'identityRelations':len(doc['relations']),
        'scope':'Independent byte/hash and core-shape verification only.'},indent=2))

if __name__ == '__main__':
    main()
