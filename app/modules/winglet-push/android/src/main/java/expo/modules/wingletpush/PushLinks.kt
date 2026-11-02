package expo.modules.wingletpush

import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder

/** Which in-app addresses a notification may open. Anything else opens Home. */
internal object PushLinks {
  private val itemId=Regex("[A-Za-z0-9_-]{1,64}")
  private fun decode(part: String)=URLDecoder.decode(part.replace("+","%2B"),"UTF-8")
  private fun plain(part: String)=part.isNotEmpty() && !part.contains('/') && !part.contains('\\') && part!=".." && part!="."
  private fun ours(candidate: String,server: String)=candidate==server || candidate.startsWith(server+"~")

  fun safePath(value: String,server: String): String = try{ check(value,server) }catch(_:Exception){"/"}

  private fun check(value: String,server: String): String {
    val uri=URI(value)
    if(uri.scheme!=null || uri.rawAuthority!=null || uri.rawFragment!=null || !value.startsWith("/"))return "/"
    val parts=uri.rawPath.split("/").drop(1).map(::decode)
    val query=uri.rawQuery
    // A chat: /chat/<server>/<chat>
    if(query==null && parts.size==3 && parts[0]=="chat" && ours(parts[1],server) && parts.all(::plain))return value
    // An inbox card: /inbox?server=<server>&item=<card>, nothing else.
    if(parts==listOf("inbox") && query!=null){
      val pairs=query.split("&").map{it.split("=",limit=2)}
      if(pairs.size!=2 || pairs.any{it.size!=2})return "/"
      val values=pairs.associate{decode(it[0]) to decode(it[1])}
      val owner=values["server"] ?: return "/"
      val card=values["item"] ?: return "/"
      if(values.size!=2 || !ours(owner,server) || !itemId.matches(card))return "/"
      return "/inbox?server="+URLEncoder.encode(owner,"UTF-8")+"&item="+URLEncoder.encode(card,"UTF-8")
    }
    return "/"
  }
}
