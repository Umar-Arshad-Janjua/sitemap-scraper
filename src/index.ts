import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { zipSync, strToU8 } from 'fflate';

interface Env {
  MY_WORKFLOW: Workflow;
  MY_BUCKET: R2Bucket;
  SCRAPING_API_TOKEN: string;
}

interface Params {
  sitemapUrl: string;
}

export class MyWorkflow extends WorkflowEntrypoint<Env, Params> {
  /**
   * Main workflow execution method
   * @param event - The workflow event containing parameters
   * @param step - The workflow step for organizing execution flow
   * @returns Object containing the download URL for the generated zip file
   */
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    // Step 1: Get Sitemap URL
    const sitemapUrl = await step.do('Get Sitemap URL', async () => {
      try {
        const url = event.payload?.sitemapUrl;
        if (!url || typeof url !== 'string') {
          throw new Error('sitemapUrl is missing or invalid. Provide it using {"sitemapUrl":"https://..."}');
        }
        return url;
      } catch (err: any) {
        throw new Error(`Get Sitemap URL failed: ${err.message}`);
      }
    });

   // Step 2: Fetch and parse URLs
const pageUrls = await step.do(
	'Fetch & Parse Sitemap',
	{
		retries: {
			limit: 0,
			delay: 1000,
			backoff: "exponential"
		},
		timeout: "10 minutes"
	},
	async () => {
	  try {
		const response = await fetch(sitemapUrl);
  
		if (!response.ok) {
		  throw new Error(`Failed to fetch sitemap: ${response.status} ${response.statusText}`);
		}
  
		const xml = await response.text();
  
		const locUrls = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map(m => m[1]);
		const aTags = [...xml.matchAll(/<a\s+href="(.*?)"/g)].map(m => m[1]);
  
		const allUrls = [...new Set([...locUrls, ...aTags])];
		if (allUrls.length === 0) {
		  throw new Error('No URLs found in sitemap.');
		}
  
		return allUrls.slice(0, 10);
	  } catch (err: any) {
		throw new Error(`Fetch & Parse Sitemap failed: ${err.message}`);
	  }
	}
  );
  

    // Step 3: Scrape markdown
    const scrapedPages = await step.do('Scrape Pages', async () => {
      try {
        const out: Array<{ fileName: string; content: string }> = [];

        for (const url of pageUrls) {
          const res = await fetch('https://api.citation-media.com/v1/scraping/fetch', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${this.env.SCRAPING_API_TOKEN}`
            },
            body: JSON.stringify({
              url,
              contextSelector: '',
              markdown: {
                images: false,
                links: {
                  type: 'ALL',
                  resourceLinks: true,
                  includeAnchors: true
                }
              }
            })
          });

          if (!res.ok) {
            console.warn(`Failed to scrape: ${url}`);
            continue;
          }

          const { markdown } = await res.json() as { markdown: string };
          const fileName = (url.split('/').filter(Boolean).pop() || 'index') + '.md';

          out.push({ fileName, content: markdown });

          // Add delay between requests to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 3000));
        }

        if (out.length === 0) {
          throw new Error('Scraping failed for all pages.');
        }

        return out;
      } catch (err: any) {
        throw new Error(`Scrape Pages failed: ${err.message}`);
      }
    });

    // Step 4: Zip & Upload to R2
    const uploadResult = await step.do('Zip and Upload to R2', async () => {
      try {
        const zipEntries: Record<string, Uint8Array> = {};
        for (const { fileName, content } of scrapedPages) {
          zipEntries[fileName] = strToU8(content);
        }

        const zipData = zipSync(zipEntries);
        const domain = sitemapUrl.split('/')[2].replace(/\./g, '_');
        const now = new Date().toISOString().replace(/[:.]/g, '-');
        const zipName = `${domain}_${now}.zip`;

        await this.env.MY_BUCKET.put(zipName, zipData);

        return {
          zipName,
          files: scrapedPages.map(p => p.fileName),
          size: zipData.length
        };
      } catch (err: any) {
        throw new Error(`Zip and Upload to R2 failed: ${err.message}`);
      }
    });

    // Step 5: Generate download URL and return response
    const finalResult = await step.do('Generate Result', async () => {
      try {
        // Generate public download URL for the uploaded zip file
        const downloadUrl = `https://pub-afa698db43a7418f8073ed229786891d.r2.dev/${uploadResult.zipName}`;
        return {
          downloadUrl
        };
      } catch (err: any) {
        throw new Error(`Generate Result failed: ${err.message}`);
      }
    });

    return finalResult;
  }
}

/**
 * HTTP handler for the worker
 * Provides endpoints to trigger workflows and check their status
 */
export default {
  async fetch(req: Request, env: Env) {
      try {
        const url = new URL(req.url);
        
        // Status endpoint to check workflow status by ID
        if (url.pathname === '/status' && req.method === 'GET') {
          const instanceId = url.searchParams.get('id');
          
          if (!instanceId) {
            return new Response('Missing workflow instance ID. Use /status?id=your-instance-id', {
              status: 400,
              headers: { 'Access-Control-Allow-Origin': '*' }
            });
          }
          
          try {
            // Get the workflow instance by ID
            const instance = await env.MY_WORKFLOW.get(instanceId);
            
            if (!instance) {
              return new Response(JSON.stringify({
                error: 'Workflow instance not found'
              }), {
                status: 404,
                headers: {
                  'Content-Type': 'application/json',
                  'Access-Control-Allow-Origin': '*'
                }
              });
            }
            
            // Get the status of the workflow instance
            const status = await instance.status();
            
            return new Response(
              JSON.stringify({
                id: instance.id,
                status
              }),
              {
                headers: {
                  'Content-Type': 'application/json',
                  'Access-Control-Allow-Origin': '*'
                }
              }
            );
          } catch (err) {
            return new Response(JSON.stringify({
              error: `Failed to get workflow status: ${err}`
            }), {
              status: 500,
              headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
              }
            });
          }
        }
        
        // Create workflow endpoint
        if (req.method === 'POST') {
          const payload: Params = await req.json();
      
          if (!payload?.sitemapUrl || typeof payload.sitemapUrl !== 'string') {
            return new Response(JSON.stringify({
              error: 'Missing or invalid sitemapUrl in request body.'
            }), {
              status: 400,
              headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
              }
            });
          }
      
          const instance = await env.MY_WORKFLOW.create({ params: payload });
      
          return new Response(
            JSON.stringify({
              id: instance.id,
              status: await instance.status()
            }),
            {
              headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
              }
            }
          );
        }
        
        // Handle OPTIONS for CORS
        if (req.method === 'OPTIONS') {
          return new Response(null, {
            headers: {
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
              'Access-Control-Allow-Headers': 'Content-Type'
            }
          });
        }
        
        // If no matching route, return 404
        return new Response(JSON.stringify({
          error: 'Not found'
        }), {
          status: 404,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });
      } catch (err) {
        return new Response(JSON.stringify({
          error: `Failed to process request: ${err}`
        }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }
    }
  };

export {};