package expo.modules.wingletpush
import org.junit.Assert.*
import org.junit.Test
class PushLinksTest {
  private val server="abc123def456"
  private fun open(value:String)=PushLinks.safePath(value,server)
  @Test fun opensTheChatForThisServerAndItsBots(){
    assertEquals("/chat/$server/general",open("/chat/$server/general"))
    assertEquals("/chat/$server%7Ebot/general",open("/chat/$server%7Ebot/general"))
  }
  @Test fun opensTheNamedInboxCard(){
    assertEquals("/inbox?server=$server&item=4e543a12932f4c60",open("/inbox?server=$server&item=4e543a12932f4c60"))
    assertEquals("/inbox?server=$server%7Ebot&item=ab12",open("/inbox?server=$server%7Ebot&item=ab12"))
  }
  @Test fun everythingElseOpensHome(){
    listOf(
      "/chat/other/general","/chat/$server/general?x=1","/chat/$server","/chat/$server/..","https://evil.example/inbox?server=$server&item=ab",
      "//evil.example/inbox","/inbox","/inbox?server=$server","/inbox?item=ab","/inbox?server=other&item=ab",
      "/inbox?server=$server&item=ab&extra=1","/inbox?server=$server&item=a/b","/inbox?server=$server&item=","/inbox?server=$server&item=..",
      "/inbox/extra?server=$server&item=ab","/inbox?server=$server&item=ab#frag","winglet:/inbox?server=$server&item=ab","","inbox","/settings",
      "/inbox?server=${server}evil&item=ab","/inbox?server=$server&server=$server&item=ab"
    ).forEach{assertEquals(it,"/",open(it))}
  }
}
