import sys
import json
import urllib.request
import sqlite3

def test_imposition():
    print("Testing DB directly...")
    try:
        conn = sqlite3.connect("d:/pdfcompare/backend/data/pdfcompare.db")
        conn.row_factory = sqlite3.Row
        c = conn.cursor()
        
        # Get latest job
        c.execute("SELECT id FROM comparison_jobs ORDER BY created_at DESC LIMIT 1")
        job = c.fetchone()
        if not job:
            return print("No job found")
            
        print(f"Latest job ID: {job['id']}")
        
        c.execute("SELECT page_number, similarity_score, diff_count, status, diff_regions, is_imposition_mode FROM page_results WHERE job_id = ?", (job['id'],))
        pages = c.fetchall()
        
        for p in pages:
            print(f"Page {p['page_number']}: score={p['similarity_score']}, diffs={p['diff_count']}, status={p['status']}, imposition={p['is_imposition_mode']}")
            if p['diff_count'] > 0:
                print("Total regions:", len(json.loads(p['diff_regions'])))
            
    except Exception as e:
        print("Error:", e)
        
if __name__ == "__main__":
    test_imposition()
