import { Injectable, Logger } from '@nestjs/common';
const mjml2html = require('mjml');

export interface EmailTemplateData {
  content: string;
  threadId: string;
  projectId?: string;
  previewUrl?: string;
  filesChanged?: string[];
  error?: string;
  isError?: boolean;
  isTimeout?: boolean;
  isAcknowledgment?: boolean;
}

@Injectable()
export class EmailTemplateService {
  private readonly logger = new Logger(EmailTemplateService.name);

  /**
   * Creates an MJML template for response emails
   */
  createResponseTemplate(data: EmailTemplateData): string {
    const mjmlTemplate = `
<mjml>
  <mj-head>
    <mj-title>WebOrdinary Edit Service</mj-title>
    <mj-attributes>
      <mj-text font-family="Arial, sans-serif" color="#333333" />
      <mj-section background-color="#ffffff" />
    </mj-attributes>
  </mj-head>
  <mj-body background-color="#f4f4f4">
    <!-- Header -->
    <mj-section background-color="#2c3e50" padding="20px">
      <mj-column>
        <mj-text color="#ffffff" font-size="24px" align="center" font-weight="bold">
          WebOrdinary Edit Service
        </mj-text>
      </mj-column>
    </mj-section>

    <!-- Main Content -->
    <mj-section padding="20px">
      <mj-column>
        <mj-text font-size="16px" line-height="1.6">
          ${this.formatContent(data.content)}
        </mj-text>
      </mj-column>
    </mj-section>

    ${data.filesChanged && data.filesChanged.length > 0 ? `
    <!-- Files Changed -->
    <mj-section padding="0 20px 20px 20px">
      <mj-column>
        <mj-text font-size="14px" font-weight="bold">
          Files Changed:
        </mj-text>
        <mj-text font-size="14px" padding-left="20px">
          ${data.filesChanged.map(f => `• ${f}`).join('<br/>')}
        </mj-text>
      </mj-column>
    </mj-section>
    ` : ''}

    ${data.previewUrl ? `
    <!-- Preview Link -->
    <mj-section padding="0 20px 20px 20px">
      <mj-column>
        <mj-button href="${data.previewUrl}" background-color="#3498db" color="#ffffff">
          Preview Your Changes
        </mj-button>
      </mj-column>
    </mj-section>
    ` : ''}

    ${data.error ? `
    <!-- Error Message -->
    <mj-section padding="0 20px 20px 20px">
      <mj-column>
        <mj-text color="#e74c3c" font-size="14px">
          <strong>Error:</strong> ${this.escapeHtml(data.error)}
        </mj-text>
      </mj-column>
    </mj-section>
    ` : ''}

    <!-- Thread ID Footer -->
    <mj-section background-color="#ecf0f1" padding="15px">
      <mj-column>
        <mj-divider border-color="#bdc3c7" />
        <mj-text font-size="12px" color="#7f8c8d" align="center" padding-top="10px">
          Conversation ID: ${data.threadId}
        </mj-text>
        <mj-text font-size="11px" color="#95a5a6" align="center">
          Please keep this ID in your reply to continue the same session
        </mj-text>
      </mj-column>
    </mj-section>

    <!-- Footer -->
    <mj-section padding="10px">
      <mj-column>
        <mj-text font-size="10px" color="#7f8c8d" align="center">
          © ${new Date().getFullYear()} WebOrdinary. All rights reserved.
        </mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`;

    return mjmlTemplate;
  }

  /**
   * Creates a simple MJML template for acknowledgment emails
   */
  createAcknowledgmentTemplate(data: EmailTemplateData): string {
    const needsEnvironment = data.content.includes('environment is being prepared');
    
    const mjmlTemplate = `
<mjml>
  <mj-head>
    <mj-title>Request Received - WebOrdinary</mj-title>
    <mj-attributes>
      <mj-text font-family="Arial, sans-serif" color="#333333" />
      <mj-section background-color="#ffffff" />
    </mj-attributes>
  </mj-head>
  <mj-body background-color="#f4f4f4">
    <!-- Header -->
    <mj-section background-color="#3498db" padding="20px">
      <mj-column>
        <mj-text color="#ffffff" font-size="24px" align="center" font-weight="bold">
          Request Received
        </mj-text>
      </mj-column>
    </mj-section>

    <!-- Status Icon -->
    <mj-section padding="30px 20px 20px 20px">
      <mj-column>
        <mj-text align="center" font-size="48px">
          ${needsEnvironment ? '⏳' : '✅'}
        </mj-text>
      </mj-column>
    </mj-section>

    <!-- Main Content -->
    <mj-section padding="0 20px 20px 20px">
      <mj-column>
        <mj-text font-size="16px" line-height="1.6" align="center">
          ${this.formatContent(data.content)}
        </mj-text>
      </mj-column>
    </mj-section>

    ${data.projectId ? `
    <!-- Project Info -->
    <mj-section padding="0 20px 20px 20px">
      <mj-column>
        <mj-text font-size="14px" align="center">
          <strong>Project:</strong> ${data.projectId}
        </mj-text>
      </mj-column>
    </mj-section>
    ` : ''}

    ${data.previewUrl ? `
    <!-- Preview Link -->
    <mj-section padding="0 20px 20px 20px">
      <mj-column>
        <mj-text font-size="14px" align="center">
          <strong>Preview URL:</strong> <a href="${data.previewUrl}">${data.previewUrl}</a>
        </mj-text>
      </mj-column>
    </mj-section>
    ` : ''}

    <!-- Thread ID Footer -->
    <mj-section background-color="#ecf0f1" padding="15px">
      <mj-column>
        <mj-divider border-color="#bdc3c7" />
        <mj-text font-size="12px" color="#7f8c8d" align="center" padding-top="10px">
          Conversation ID: ${data.threadId}
        </mj-text>
        <mj-text font-size="11px" color="#95a5a6" align="center">
          Please keep this ID in your reply to continue the same session
        </mj-text>
      </mj-column>
    </mj-section>

    <!-- Footer -->
    <mj-section padding="10px">
      <mj-column>
        <mj-text font-size="10px" color="#7f8c8d" align="center">
          © ${new Date().getFullYear()} WebOrdinary. All rights reserved.
        </mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`;

    return mjmlTemplate;
  }

  /**
   * Renders MJML to HTML
   */
  renderMjml(mjmlTemplate: string): { html: string; text: string } {
    try {
      const { html, errors } = mjml2html(mjmlTemplate, { 
        validationLevel: 'soft',
        minify: true 
      });
      
      if (errors && errors.length > 0) {
        this.logger.warn('MJML validation warnings:', errors);
      }

      // Extract text version from content
      const textContent = this.extractTextFromHtml(html);

      return { html, text: textContent };
    } catch (error) {
      this.logger.error('Failed to render MJML template:', error);
      throw error;
    }
  }

  /**
   * Helper to format content with line breaks
   */
  private formatContent(content: string): string {
    return content
      .split('\n')
      .filter(line => line.trim())
      .map(line => `<p>${this.escapeHtml(line)}</p>`)
      .join('');
  }

  /**
   * Helper to escape HTML characters
   */
  private escapeHtml(text: string): string {
    const map: { [key: string]: string } = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, m => map[m]);
  }

  /**
   * Extract plain text from HTML
   */
  private extractTextFromHtml(html: string): string {
    // Simple extraction - in production, use a proper HTML parser
    return html
      .replace(/<style[^>]*>.*?<\/style>/gs, '')
      .replace(/<script[^>]*>.*?<\/script>/gs, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Build MIME message for raw email sending
   */
  buildMimeMessage(params: {
    from: string;
    to: string;
    subject: string;
    html: string;
    text: string;
    inReplyTo?: string;
    references?: string;
  }): string {
    const boundary = `boundary_${Date.now()}_${Math.random().toString(36).substring(2)}`;
    
    const headers = [
      `From: ${params.from}`,
      `To: ${params.to}`,
      `Subject: ${params.subject}`,
      `MIME-Version: 1.0`,
    ];

    if (params.inReplyTo) {
      headers.push(`In-Reply-To: ${params.inReplyTo}`);
    }
    if (params.references) {
      headers.push(`References: ${params.references}`);
    }

    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);

    const mime = [
      ...headers,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      params.text,
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      params.html,
      '',
      `--${boundary}--`,
    ];

    return mime.join('\r\n');
  }
}