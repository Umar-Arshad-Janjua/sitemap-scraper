# Cloudflare Sitemap Scraping Workflow

This workflow automates the process of turning a sitemap into a downloadable archive of markdown files. It takes a sitemap URL, extracts page links, scrapes the content of each page, converts it to markdown, and packages everything into a ZIP file.

## What the Workflow Does

1. **Takes a Sitemap URL**  
   Accepts a valid sitemap URL containing links to web pages.

2. **Parses URLs from Sitemap**  
   Fetches and parses the sitemap XML, extracting links from url.

3. **Scrapes Page Content**  
   Each URL is sent to a scraping API that returns the content in markdown format.

4. **Generates Markdown Files**  
   A separate `.md` file is created for each successfully scraped page.

5. **Creates ZIP Archive**  
   All markdown files are zipped together into one archive.

6. **Uploads to Cloud Storage**  
   The ZIP file is uploaded to Cloudflare R2, and a public download link is returned.

## Output

A ZIP archive containing markdown files for each scraped page, along with a publicly accessible download URL.

## Technical Notes

- Runs on Cloudflare Workers using Durable Workflows.
- Uses Cloudflare R2 for storing and serving the ZIP archive.
- Utilizes a scraping API to extract content in markdown.
