import { Tool } from "@langchain/core/tools";
import { CMSTool, BuildHookTool, EmailReplyTool } from "./cms.tool";

export function createTools(): Tool[] {
  return [
    // CMS Tools
    new CMSTool(
      "cms.addPhoto",
      "/photos",
      "POST",
      "Add a new photo to the CMS"
    ),
    new CMSTool(
      "cms.updatePage",
      "/pages/:id",
      "PUT",
      "Update an existing page in the CMS"
    ),
    new CMSTool(
      "cms.deletePage",
      "/pages/:id",
      "DELETE",
      "Delete a page from the CMS (requires confirmation)"
    ),
    new CMSTool(
      "cms.createPost",
      "/posts",
      "POST",
      "Create a new blog post"
    ),
    new CMSTool(
      "cms.updatePost",
      "/posts/:id",
      "PUT",
      "Update an existing blog post"
    ),
    new CMSTool(
      "cms.listContent",
      "/:resource",
      "GET",
      "List content of a specific type"
    ),
    
    // Build Tool
    new BuildHookTool(process.env.BUILD_HOOK_URL || ""),
    
    // Email Tool
    new EmailReplyTool()
  ];
}

export { CMSTool, BuildHookTool, EmailReplyTool };