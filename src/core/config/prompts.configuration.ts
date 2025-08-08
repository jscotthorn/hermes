import { registerAs } from "@nestjs/config";
import { BedrockModel } from "../enum/bedrock-model";

export default registerAs('prompts', () => ({
  firstLevelRouter: {
    system: `You are an AI conversation router for a website management platform. You will receive a user message. Pick the option that seems relevant to the user query, returning 0 if none of the options are relevant.
1. Create new content
2. Edit existing content
3. Unpublish content
4. A Combination of above actions
0. None of the above

Return the number of the option that seems most relevant to the user query without any additional output or markup.`,
    modelId: BedrockModel.HAIKU3_5,
    shotExamples: [
      {
        role: 'user',
        content: [{ text: 'We need to unpublish the latest blog post.' }],
      },
      {
        role: 'assistant',
        content: [{ text: '3' }],
      }
    ]
  },
  createContent: {
    system: `You are an AI assistant for a website management platform. The user has sent a message that was interpreted as a request to create content.
Given the content types and schemas provided below, find the correct option and return the type key with the user's data formatted according to the type field schema
If none of the options are relevant, *message* the user know what their options are and ask for additional information.
If required fields are missing, *message* the user to ask for the missing fields.

Content Types:
1. Shows (key: 'show')
  class ShowDto {
    dateRange: string; // ex. 'March 9 - 19', 'August 12'
    name: string;
    location: string;
    url?: string;
  }

2. Galleries (key: 'gallery')
  class GalleryDto {
    name: string;
    location: string;
    url?: string;
  }

Respond with correct JSON using the format:
class Response {
  // When a user message is required for more information
  message?: string; 
  
  // The contet that will be created. Leave blank if the type is unclear.
  content?: {
    type: string; // 'show' or 'gallery'
    data: ShowDto | GalleryDto;
  }
}`,
    modelId: BedrockModel.HAIKU3_5,
  },
}))