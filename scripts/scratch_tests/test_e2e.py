"""End-to-end test of the PDF comparison API."""
import urllib.request
import json
import time
import os

BASE = 'http://localhost:8000'

def make_multipart(filepath, fieldname='file'):
    boundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW'
    filename = os.path.basename(filepath)
    with open(filepath, 'rb') as f:
        data = f.read()
    body = (
        '--' + boundary + '\r\n'
        'Content-Disposition: form-data; name="' + fieldname + '"; filename="' + filename + '"\r\n'
        'Content-Type: application/pdf\r\n\r\n'
    ).encode() + data + ('\r\n--' + boundary + '--\r\n').encode()
    return body, boundary

# Upload file A
print('=== UPLOADING ===')
body_a, boundary = make_multipart('d:/pdfcompare/test_original.pdf')
req = urllib.request.Request(BASE + '/api/upload', data=body_a)
req.add_header('Content-Type', 'multipart/form-data; boundary=' + boundary)
resp = urllib.request.urlopen(req)
file_a = json.loads(resp.read())
print('File A: ' + file_a['id'][:8] + '... pages=' + str(file_a.get('page_count')))

# Upload file B
body_b, boundary = make_multipart('d:/pdfcompare/test_modified.pdf')
req = urllib.request.Request(BASE + '/api/upload', data=body_b)
req.add_header('Content-Type', 'multipart/form-data; boundary=' + boundary)
resp = urllib.request.urlopen(req)
file_b = json.loads(resp.read())
print('File B: ' + file_b['id'][:8] + '... pages=' + str(file_b.get('page_count')))

# Create comparison job
print('\n=== COMPARING ===')
job_data = json.dumps({
    'file_a_id': file_a['id'],
    'file_b_id': file_b['id'],
    'dpi': 150,
    'tolerance': 'NORMAL',
}).encode()
req = urllib.request.Request(BASE + '/api/jobs/compare', data=job_data)
req.add_header('Content-Type', 'application/json')
resp = urllib.request.urlopen(req)
job = json.loads(resp.read())
job_id = job['job_id']
print('Job: ' + job_id[:8] + '...')

# Poll status
for i in range(30):
    time.sleep(2)
    resp = urllib.request.urlopen(BASE + '/api/jobs/' + job_id)
    status = json.loads(resp.read())
    s = status['status']
    p = str(status.get('progress', 0))
    print('  [' + str(i*2) + 's] status=' + s + ' progress=' + p + '%')
    if s in ('completed', 'failed'):
        break

if status['status'] == 'completed':
    resp = urllib.request.urlopen(BASE + '/api/jobs/' + job_id + '/results')
    results = json.loads(resp.read())
    print('\n=== RESULTS ===')
    summary = results.get('summary', {})
    print('Overall: ' + str(summary.get('overall_status', 'N/A')))
    print('Similarity: ' + str(summary.get('average_similarity', 'N/A')) + '%')
    print('Total diffs: ' + str(summary.get('total_diff_count', 'N/A')))
    for p in results.get('pages', []):
        pn = str(p['page_number'])
        ps = p['status']
        sim = str(p['similarity_score'])
        dc = str(p['diff_count'])
        print('  Page ' + pn + ': ' + ps + ' sim=' + sim + '% diffs=' + dc)
    print('\n=== SUCCESS ===')
else:
    print('\n=== FAILED ===')
    print('Error: ' + str(status.get('error_message')))
